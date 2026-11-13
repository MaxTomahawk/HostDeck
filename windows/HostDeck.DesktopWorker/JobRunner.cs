using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HostDeck.DesktopWorker;

// One detached user-token process per durable command. The child is created
// suspended and assigned to a Windows Job Object before any instruction runs.
// Closing the Job Object kills descendants without looking up reusable PIDs.
internal static class JobRunner
{
    internal static async Task Run(string requestPath)
    {
        var status = "failed";
        uint? exitCode = null;
        var descendantsContained = false;
        var started = DateTimeOffset.UtcNow;
        var safePaths = TryGetOwnedPaths(requestPath);
        try {
            if (safePaths is null) throw new InvalidDataException("Invalid job request path.");
            var request = JsonSerializer.Deserialize<JobRequest>(await File.ReadAllTextAsync(requestPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidDataException("Invalid job request.");
            Validate(request, safePaths);
            try { (status, exitCode, descendantsContained) = await Execute(request); }
            catch { status = "uncertain"; exitCode = null; descendantsContained = false; }
        } catch (Exception) {
            status = "failed";
        } finally {
            if (safePaths is not null) {
                try { if (!File.Exists(safePaths.Stdout)) using (File.Create(safePaths.Stdout)) { } } catch { }
                try { if (!File.Exists(safePaths.Stderr)) using (File.Create(safePaths.Stderr)) { } } catch { }
                var receipt = new {
                    status, exitCode, startedAt = started, endedAt = DateTimeOffset.UtcNow,
                    descendantsContained
                };
                var temp = safePaths.Receipt + ".tmp-" + Guid.NewGuid().ToString("N");
                try {
                    await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(receipt));
                    File.Move(temp, safePaths.Receipt, false);
                } finally { try { File.Delete(temp); } catch { } }
            }
        }
    }

    private sealed record OwnedPaths(string Receipt, string Stdout, string Stderr, string Cancel, string Marker);

    private static OwnedPaths? TryGetOwnedPaths(string requestPath)
    {
        try {
            var full = Path.GetFullPath(requestPath);
            var match = Regex.Match(Path.GetFileName(full), @"^(?<id>[0-9a-f]{32})\.request\.json$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!match.Success) return null;
            var directory = Path.GetDirectoryName(full)!;
            var id = match.Groups["id"].Value;
            return new OwnedPaths(Path.Combine(directory, id + ".json"), Path.Combine(directory, id + ".out"),
                Path.Combine(directory, id + ".err"), Path.Combine(directory, id + ".cancel"), Path.Combine(directory, id + ".live.json"));
        } catch { return null; }
    }

    private static void Validate(JobRequest r, OwnedPaths safePaths)
    {
        if (Native.IsElevated() || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0)
            throw new InvalidOperationException("Job runner must use unelevated user token.");
        if (string.IsNullOrWhiteSpace(r.Command) || r.Command.Length > 100_000 || r.TimeoutSeconds is < 1 or > 604800)
            throw new InvalidDataException("Invalid command or timeout.");
        foreach (var path in new[] { r.ShellExecutable, r.Cwd, r.StdoutPath, r.StderrPath, r.ReceiptPath, r.CancelPath, r.StatusMarkerPath })
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
                throw new InvalidDataException("Absolute paths required.");
        if (!PathEquals(r.ReceiptPath, safePaths.Receipt) || !PathEquals(r.StdoutPath, safePaths.Stdout)
            || !PathEquals(r.StderrPath, safePaths.Stderr) || !PathEquals(r.CancelPath, safePaths.Cancel)
            || !PathEquals(r.StatusMarkerPath, safePaths.Marker))
            throw new InvalidDataException("Job paths must match the private request identity.");
        if (!File.Exists(r.ShellExecutable) || !Directory.Exists(r.Cwd)) throw new FileNotFoundException("Shell or working directory missing.");
        if (new[] { r.StdoutPath, r.StderrPath, r.ReceiptPath, r.CancelPath, r.StatusMarkerPath }.Distinct(StringComparer.OrdinalIgnoreCase).Count() != 5)
            throw new InvalidDataException("Job paths must be distinct.");
        if (r.Environment is { Count: > 128 } || r.Environment?.Any(pair =>
            string.IsNullOrEmpty(pair.Key) || pair.Key.Contains('=') || pair.Key.Contains('\0') || pair.Value.Contains('\0')) == true)
            throw new InvalidDataException("Invalid environment.");
    }

    private static bool PathEquals(string left, string right)
    {
        try { return string.Equals(Path.GetFullPath(left), right, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    private static async Task<(string Status, uint? ExitCode, bool DescendantsContained)> Execute(JobRequest r)
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
            // The caller supplies a filtered environment. Never inherit the
            // runner's full environment, which can contain credentials.
            environment = EnvironmentBlock(r.Environment ?? new Dictionary<string, string>());
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
            while (true) {
                var wait = JobNative.WaitForSingleObject(process.hProcess, 250);
                if (wait == 0) break;
                if (wait != 0x102) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (File.Exists(r.CancelPath)) {
                    return StopTree(job, process.hProcess, "cancelled");
                }
                if (DateTimeOffset.UtcNow >= deadline) {
                    return StopTree(job, process.hProcess, "timed_out");
                }
                await Task.Yield();
            }
            if (!JobNative.GetExitCodeProcess(process.hProcess, out var exit))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!TryGetActiveProcessCount(job, out var remaining)) {
                // The shell may have already exited while a descendant is
                // still executing. A simultaneous owner cancellation/timeout
                // takes precedence, but is confirmed ONLY if TerminateJobObject
                // and owned-job accounting verify containment.
                if (File.Exists(r.CancelPath)) return StopTree(job, process.hProcess, "cancelled");
                if (DateTimeOffset.UtcNow >= deadline) return StopTree(job, process.hProcess, "timed_out");
                var contained = EnsureNoDescendants(job, process.hProcess, 5000);
                return ("uncertain", exit, contained);
            }
            if (remaining > 0) {
                if (File.Exists(r.CancelPath)) return StopTree(job, process.hProcess, "cancelled");
                if (DateTimeOffset.UtcNow >= deadline) return StopTree(job, process.hProcess, "timed_out");
                var contained = EnsureNoDescendants(job, process.hProcess, 5000);
                return contained ? ("interrupted", exit, true) : ("uncertain", exit, false);
            }
            return (exit == 0 ? "completed" : "failed", exit, true);
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

    private static (string Status, uint? ExitCode, bool DescendantsContained) StopTree(nint job, nint process, string requestedStatus)
        => EnsureNoDescendants(job, process, 5000) ? (requestedStatus, null, true) : ("uncertain", null, false);

    private static bool EnsureNoDescendants(nint job, nint process, int timeoutMs)
    {
        if (!JobNative.TerminateJobObject(job, 1)) return false;
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true) {
            var processWait = JobNative.WaitForSingleObject(process, 0);
            if (processWait != 0 && processWait != 0x102) return false;
            if (!TryGetActiveProcessCount(job, out var activeProcesses)) return false;
            if (activeProcesses == 0 && processWait == 0) return true;
            if (Environment.TickCount64 >= deadline) return false;
            Thread.Sleep(25);
        }
    }

    private static bool TryGetActiveProcessCount(nint job, out uint activeProcesses)
    {
        activeProcesses = 0;
        if (!JobNative.QueryInformationJobObject(job, 1, out var info,
                Marshal.SizeOf<JobNative.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), 0))
            return false;
        activeProcesses = info.ActiveProcesses;
        return true;
    }

    private static nint EnvironmentBlock(Dictionary<string, string> additions)
    {
        var map = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in additions) map[pair.Key] = pair.Value;
        return Marshal.StringToHGlobalUni(string.Join('\0', map.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0");
    }

    private static StringBuilder ShellCommand(JobRequest r)
    {
        var filename = Path.GetFileName(r.ShellExecutable).ToLowerInvariant();
        var argument = filename switch {
            "powershell.exe" or "pwsh.exe" => "-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand "
                + Convert.ToBase64String(Encoding.Unicode.GetBytes("$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[Text.UTF8Encoding]::new($false);\n" + r.Command)),
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
    [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        internal long TotalUserTime; internal long TotalKernelTime; internal long ThisPeriodTotalUserTime; internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaults; internal uint TotalProcesses; internal uint ActiveProcesses; internal uint TotalTerminatedProcesses;
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
    internal static extern bool QueryInformationJobObject(nint job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, nint returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);
}
