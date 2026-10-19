using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace HostDeck.DesktopWorker;

// One detached user-token process per durable command. The child is created
// suspended and assigned to a Windows Job Object before any instruction runs.
// Closing the Job Object kills descendants without looking up reusable PIDs.
internal static class JobRunner
{
    internal static async Task Run(string requestPath)
    {
        var request = JsonSerializer.Deserialize<JobRequest>(await File.ReadAllTextAsync(requestPath),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("Invalid job request.");
        Validate(request);
        var status = "failed";
        uint? exitCode = null;
        var started = DateTimeOffset.UtcNow;
        try {
            (status, exitCode) = await Execute(request);
        } catch (Exception) {
            status = "failed";
        } finally {
            var receipt = new {
                status, exitCode, startedAt = started, endedAt = DateTimeOffset.UtcNow,
                descendantsContained = true
            };
            var temp = request.ReceiptPath + ".tmp-" + Guid.NewGuid().ToString("N");
            await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(receipt));
            File.Move(temp, request.ReceiptPath, false);
        }
    }

    private static void Validate(JobRequest r)
    {
        if (Native.IsElevated() || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0)
            throw new InvalidOperationException("Job runner must use unelevated user token.");
        if (string.IsNullOrWhiteSpace(r.Command) || r.Command.Length > 100_000 || r.TimeoutSeconds is < 1 or > 604800)
            throw new InvalidDataException("Invalid command or timeout.");
        foreach (var path in new[] { r.ShellExecutable, r.Cwd, r.StdoutPath, r.StderrPath, r.ReceiptPath, r.CancelPath, r.StatusMarkerPath })
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
                throw new InvalidDataException("Absolute paths required.");
        if (!File.Exists(r.ShellExecutable) || !Directory.Exists(r.Cwd)) throw new FileNotFoundException("Shell or working directory missing.");
        if (new[] { r.StdoutPath, r.StderrPath, r.ReceiptPath, r.CancelPath, r.StatusMarkerPath }.Distinct(StringComparer.OrdinalIgnoreCase).Count() != 5)
            throw new InvalidDataException("Job paths must be distinct.");
        if (r.Environment is { Count: > 128 } || r.Environment?.Any(pair =>
            string.IsNullOrEmpty(pair.Key) || pair.Key.Contains('=') || pair.Key.Contains('\0') || pair.Value.Contains('\0')) == true)
            throw new InvalidDataException("Invalid environment.");
    }

    private static async Task<(string Status, uint? ExitCode)> Execute(JobRequest r)
    {
        var job = JobNative.CreateJobObject(0, null);
        if (job == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        nint stdout = 0, stderr = 0, stdin = 0;
        nint environment = 0;
        JobNative.PROCESS_INFORMATION process = default;
        try {
            var limits = new JobNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation = new JobNative.JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags = 0x00002000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                }
            };
            if (!JobNative.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<JobNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var attributes = new JobNative.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<JobNative.SECURITY_ATTRIBUTES>(), bInheritHandle = true };
            stdout = JobNative.CreateFile(r.StdoutPath, 0x40000000, 1, ref attributes, 2, 0x80, 0);
            stderr = JobNative.CreateFile(r.StderrPath, 0x40000000, 1, ref attributes, 2, 0x80, 0);
            stdin = JobNative.CreateFile("NUL", 0x80000000, 1, ref attributes, 3, 0x80, 0);
            if (stdout == -1 || stderr == -1 || stdin == -1) throw new Win32Exception(Marshal.GetLastWin32Error());
            var startup = new JobNative.STARTUPINFO {
                cb = Marshal.SizeOf<JobNative.STARTUPINFO>(), dwFlags = 0x00000100,
                hStdInput = stdin, hStdOutput = stdout, hStdError = stderr
            };
            var commandLine = ShellCommand(r);
            if (r.Environment is { Count: > 0 }) environment = EnvironmentBlock(r.Environment);
            // CREATE_SUSPENDED, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT.
            if (!JobNative.CreateProcess(r.ShellExecutable, commandLine, 0, 0, true,
                0x00000004 | 0x08000000 | 0x00000400, environment, r.Cwd, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (environment != 0) { Marshal.FreeHGlobal(environment); environment = 0; }
            if (!JobNative.AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            var child = System.Diagnostics.Process.GetProcessById(checked((int)process.dwProcessId));
            JobStatus.WriteMarker(r.StatusMarkerPath, new JobStatus.Marker(
                process.dwProcessId, child.StartTime.ToUniversalTime().Ticks, child.SessionId,
                identity.User?.Value ?? throw new InvalidOperationException("Runner SID unavailable."),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            if (JobNative.ResumeThread(process.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            // Parent closes its inherited file handles; only the job tree holds
            // them while output is produced.
            JobNative.CloseHandle(stdout); stdout = 0;
            JobNative.CloseHandle(stderr); stderr = 0;
            JobNative.CloseHandle(stdin); stdin = 0;
            var deadline = DateTimeOffset.UtcNow.AddSeconds(r.TimeoutSeconds);
            while (JobNative.WaitForSingleObject(process.hProcess, 250) == 0x102) {
                if (File.Exists(r.CancelPath)) {
                    JobNative.TerminateJobObject(job, 1);
                    JobNative.WaitForSingleObject(process.hProcess, 5000);
                    return ("cancelled", null);
                }
                if (DateTimeOffset.UtcNow >= deadline) {
                    JobNative.TerminateJobObject(job, 1);
                    JobNative.WaitForSingleObject(process.hProcess, 5000);
                    return ("timed_out", null);
                }
                await Task.Yield();
            }
            if (!JobNative.GetExitCodeProcess(process.hProcess, out var exit))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return (exit == 0 ? "completed" : "failed", exit);
        } finally {
            if (process.hThread != 0) JobNative.CloseHandle(process.hThread);
            if (process.hProcess != 0) JobNative.CloseHandle(process.hProcess);
            if (stdout != 0 && stdout != -1) JobNative.CloseHandle(stdout);
            if (stderr != 0 && stderr != -1) JobNative.CloseHandle(stderr);
            if (stdin != 0 && stdin != -1) JobNative.CloseHandle(stdin);
            if (environment != 0) Marshal.FreeHGlobal(environment);
            JobNative.CloseHandle(job);
        }
    }

    private static nint EnvironmentBlock(Dictionary<string, string> additions)
    {
        var map = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables())
            if (item.Key is string key && !key.StartsWith('=')) map[key] = item.Value?.ToString() ?? "";
        foreach (var pair in additions) map[pair.Key] = pair.Value;
        return Marshal.StringToHGlobalUni(string.Join('\0', map.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0");
    }

    private static StringBuilder ShellCommand(JobRequest r)
    {
        var filename = Path.GetFileName(r.ShellExecutable).ToLowerInvariant();
        var argument = filename switch {
            "powershell.exe" or "pwsh.exe" => "-NoLogo -NoProfile -NonInteractive -EncodedCommand "
                + Convert.ToBase64String(Encoding.Unicode.GetBytes(r.Command)),
            "cmd.exe" => "/d /s /c " + Quote(r.Command),
            _ => throw new InvalidDataException("Unsupported shell executable.")
        };
        return new StringBuilder('"' + r.ShellExecutable + '"' + " " + argument);
    }
    private static string Quote(string value) => '"' + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + '"';

    private sealed record JobRequest(
        string Command, string Cwd, string ShellExecutable, int TimeoutSeconds,
        string StdoutPath, string StderrPath, string ReceiptPath, string CancelPath, string StatusMarkerPath,
        Dictionary<string, string>? Environment);
}

internal static class JobNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES {
        internal int nLength; internal nint lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO {
        internal int cb; internal string? lpReserved; internal string? lpDesktop; internal string? lpTitle;
        internal int dwX; internal int dwY; internal int dwXSize; internal int dwYSize;
        internal int dwXCountChars; internal int dwYCountChars; internal int dwFillAttribute;
        internal int dwFlags; internal short wShowWindow; internal short cbReserved2;
        internal nint lpReserved2; internal nint hStdInput; internal nint hStdOutput; internal nint hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION {
        internal nint hProcess; internal nint hThread; internal uint dwProcessId; internal uint dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        internal long PerProcessUserTimeLimit; internal long PerJobUserTimeLimit;
        internal uint LimitFlags; internal nuint MinimumWorkingSetSize; internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit; internal nint Affinity; internal uint PriorityClass; internal uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS {
        internal ulong ReadOperationCount; internal ulong WriteOperationCount; internal ulong OtherOperationCount;
        internal ulong ReadTransferCount; internal ulong WriteTransferCount; internal ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; internal IO_COUNTERS IoInfo;
        internal nuint ProcessMemoryLimit; internal nuint JobMemoryLimit; internal nuint PeakProcessMemoryUsed; internal nuint PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nint CreateJobObject(nint attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(nint job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern nint CreateFile(
        string filename, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, nint template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcess(string application, StringBuilder command, nint processAttributes,
        nint threadAttributes, bool inheritHandles, uint flags, nint environment, string cwd,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(nint job, nint process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(nint handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(nint process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(nint job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);
}
