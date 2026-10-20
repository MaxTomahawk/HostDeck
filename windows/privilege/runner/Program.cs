// Adapted from HostDeck DesktopWorker JobRunner.cs (MIT) at commit
// 2c4929dd4b118e41eedd714c973c35398271adaf; see ../LICENSES/PROVENANCE.md.
// Specialized only for LOCAL SYSTEM/Session-0 requests from a protected queue.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

internal sealed record JobRequest(
    [property: JsonPropertyName("schema")] int Schema,
    [property: JsonPropertyName("job_id")] string JobId,
    [property: JsonPropertyName("script_path")] string ScriptPath,
    [property: JsonPropertyName("timeout_seconds")] int TimeoutSeconds);
internal sealed record RunResult(string Status, uint? ExitCode, bool DescendantsContained,
    string Error, DateTimeOffset StartedUtc, DateTimeOffset FinishedUtc);

internal static class Program
{
    static int Main(string[] args)
    {
        if (args.Length != 1 || !OperatingSystem.IsWindows()) return 65;
        if (WindowsIdentity.GetCurrent().User?.Value != "S-1-5-18" || Process.GetCurrentProcess().SessionId != 0)
            return 77;
        var started = DateTimeOffset.UtcNow;
        string? receipt = null;
        RunResult outcome;
        try
        {
            var root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "CodexMandateBridge", "work", "jobs"));
            var input = Path.GetFullPath(args[0]);
            if (!string.Equals(Path.GetDirectoryName(input), root, StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(input), "^[0-9a-f]{32}\\.request\\.json$", RegexOptions.CultureInvariant))
                throw new InvalidDataException("INVALID_PROTECTED_JOB_PATH");
            EnsureNotReparse(input);
            var id = Path.GetFileName(input)[..32];
            receipt = Path.Combine(root, id + ".result.json");
            var source = File.ReadAllBytes(input);
            if (source.Length is < 20 or > 16000) throw new InvalidDataException("INVALID_JOB_REQUEST_SIZE");
            var r = JsonSerializer.Deserialize<JobRequest>(source,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidDataException("MISSING_JOB_REQUEST");
            if (r.Schema != 1 || r.JobId != id || r.TimeoutSeconds is < 10 or > 900)
                throw new InvalidDataException("INVALID_JOB_REQUEST_FIELDS");
            var workDir = Path.GetFullPath(Path.Combine(root, "..", id[..8] + "-" + id[8..12] + "-" + id[12..16] + "-" + id[16..20] + "-" + id[20..]));
            var expected = Path.Combine(workDir, "action.ps1");
            if (!string.Equals(Path.GetFullPath(r.ScriptPath), expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("SCRIPT_OUTSIDE_PROTECTED_WORKDIR");
            EnsureNotReparse(workDir);
            EnsureNotReparse(expected);
            outcome = RunJob(r, root, started);
        }
        catch (Exception ex)
        {
            outcome = new RunResult("uncertain-or-denied", null, false, ex.GetType().Name + ": " + ex.Message,
                started, DateTimeOffset.UtcNow);
        }
        if (receipt is not null)
        {
            try
            {
                var tmp = receipt + ".tmp-" + Guid.NewGuid().ToString("N");
                File.WriteAllText(tmp, JsonSerializer.Serialize(new {
                    status = outcome.Status, exit_code = outcome.ExitCode,
                    descendants_contained = outcome.DescendantsContained,
                    error = outcome.Error, started_utc = outcome.StartedUtc, finished_utc = outcome.FinishedUtc
                }));
                File.Move(tmp, receipt, overwrite: false);
            }
            catch { return 70; }
        }
        return outcome.Status == "completed" ? 0 : 1;
    }

    static void EnsureNotReparse(string path)
    {
        var current = Path.GetFullPath(path);
        while (Directory.Exists(current) || File.Exists(current))
        {
            if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                throw new InvalidDataException("REPARSE_POINT_IN_PRIVILEGED_PATH");
            var parent = Path.GetDirectoryName(current);
            if (parent is null || parent == current) break;
            current = parent;
        }
    }

    static RunResult RunJob(JobRequest request, string jobsRoot, DateTimeOffset started)
    {
        var id = request.JobId;
        var stdoutPath = Path.Combine(jobsRoot, id + ".out");
        var stderrPath = Path.Combine(jobsRoot, id + ".err");
        var psExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(psExe)) throw new FileNotFoundException("WINDOWS_POWERSHELL_UNAVAILABLE");
        nint job = 0, hOut = 0, hErr = 0, hIn = 0;
        Native.PROCESS_INFORMATION p = default;
        string status = "uncertain", error = "";
        uint? exitCode = null;
        bool contained = false;
        try
        {
            job = Native.CreateJobObject(0, null);
            if (job == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation = new Native.JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags = 0x00002000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                }
            };
            if (!Native.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var attr = new Native.SECURITY_ATTRIBUTES { nLength=Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle=true };
            hOut = Native.CreateFile(stdoutPath, 0x40000000, 1, ref attr, 2, 0x80, 0);
            hErr = Native.CreateFile(stderrPath, 0x40000000, 1, ref attr, 2, 0x80, 0);
            hIn = Native.CreateFile("NUL", 0x80000000, 1, ref attr, 3, 0x80, 0);
            if (hOut == -1 || hErr == -1 || hIn == -1) throw new Win32Exception(Marshal.GetLastWin32Error());
            var si = new Native.STARTUPINFO { cb=Marshal.SizeOf<Native.STARTUPINFO>(), dwFlags=0x100,
                hStdInput=hIn, hStdOutput=hOut, hStdError=hErr };
            // Only a validated script path under protected work is substituted.
            var command = new StringBuilder('"'+psExe+'"'+" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+request.ScriptPath+"\"");
            // Avoid copying arbitrary broker environment variables to the delegated SYSTEM script.
            var winRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var envEntries = new [] {
                "ComSpec=" + Path.Combine(winRoot, "System32", "cmd.exe"),
                "Path=" + Path.Combine(winRoot, "System32") + ";" + winRoot,
                "ProgramData=" + Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "SystemDrive=" + Path.GetPathRoot(winRoot)!.TrimEnd('\\'),
                "SystemRoot=" + winRoot, "TEMP=" + jobsRoot, "TMP=" + jobsRoot,
                "WINDIR=" + winRoot
            };
            var envBlock = Marshal.StringToHGlobalUni(string.Join('\0', envEntries) + "\0\0");
            try {
                if (!Native.CreateProcess(psExe, command, 0, 0, true,
                    0x00000004 | 0x08000000 | 0x00000400, envBlock, jobsRoot, ref si, out p))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { Marshal.FreeHGlobal(envBlock); }
            if (!Native.AssignProcessToJobObject(job, p.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (Native.ResumeThread(p.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            Native.CloseHandle(hOut); hOut=0; Native.CloseHandle(hErr);hErr=0;Native.CloseHandle(hIn);hIn=0;
            var until = DateTimeOffset.UtcNow.AddSeconds(request.TimeoutSeconds);
            while (true)
            {
                var wait=Native.WaitForSingleObject(p.hProcess,250);
                if(wait == 0) break;
                if(wait != 0x102) throw new Win32Exception(Marshal.GetLastWin32Error());
                if(DateTimeOffset.UtcNow >= until){ status="timed_out"; break; }
                foreach(var path in new[] {stdoutPath,stderrPath})
                    if(File.Exists(path) && new FileInfo(path).Length > 16*1024*1024){status="output_limit";break;}
                if(status=="output_limit") break;
            }
            if(status is "timed_out" or "output_limit")
            {
                contained=TerminateAndVerify(job,p.hProcess);
                return new RunResult(contained?status:"uncertain",null,contained,contained?"":"JOB_TERMINATION_NOT_CONFIRMED",started,DateTimeOffset.UtcNow);
            }
            if(!Native.GetExitCodeProcess(p.hProcess,out uint code))throw new Win32Exception(Marshal.GetLastWin32Error());
            exitCode=code;
            if (!Native.QueryInformationJobObject(job,1,out var basic,Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(),0))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (basic.ActiveProcesses > 0)
            {
                contained=TerminateAndVerify(job,p.hProcess);
                status=contained?"descendants_interrupted":"uncertain";
            }
            else {contained=true;status=code==0?"completed":"failed";}
            return new RunResult(status,exitCode,contained,error,started,DateTimeOffset.UtcNow);
        }
        catch(Exception e)
        {
            error=e.GetType().Name+": "+e.Message;
            contained=job!=0 && p.hProcess!=0 && TerminateAndVerify(job,p.hProcess);
            return new RunResult("uncertain",exitCode,contained,error,started,DateTimeOffset.UtcNow);
        }
        finally
        {
            if(p.hThread!=0) Native.CloseHandle(p.hThread);
            if(p.hProcess!=0) Native.CloseHandle(p.hProcess);
            if(hOut!=0 && hOut!=-1) Native.CloseHandle(hOut);
            if(hErr!=0 && hErr!=-1) Native.CloseHandle(hErr);
            if(hIn!=0 && hIn!=-1) Native.CloseHandle(hIn);
            if(job!=0)Native.CloseHandle(job);
        }
    }
    static bool TerminateAndVerify(nint job,nint process)
    {
        if(!Native.TerminateJobObject(job,1))return false;
        var limit=Environment.TickCount64+5000;
        while(Environment.TickCount64<limit)
        {
            var waited=Native.WaitForSingleObject(process,0);
            if(waited!=0 && waited!=0x102) return false;
            if(Native.QueryInformationJobObject(job,1,out var b,
                Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(),0)
                && waited==0 && b.ActiveProcesses==0)return true;
            Thread.Sleep(25);
        }
        return false;
    }
}
internal static class Native
{
    [StructLayout(LayoutKind.Sequential)]internal struct SECURITY_ATTRIBUTES { internal int nLength;internal nint lpSecurityDescriptor;[MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]internal struct STARTUPINFO {
        internal int cb;internal string? lpReserved;internal string? lpDesktop;internal string? lpTitle;
        internal int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
        internal short wShowWindow,cbReserved2;internal nint lpReserved2,hStdInput,hStdOutput,hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]internal struct PROCESS_INFORMATION {internal nint hProcess,hThread;internal uint dwProcessId,dwThreadId;}
    [StructLayout(LayoutKind.Sequential)]internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        internal long PerProcessUserTimeLimit,PerJobUserTimeLimit;internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize,MaximumWorkingSetSize;internal uint ActiveProcessLimit;
        internal nint Affinity;internal uint PriorityClass,SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]internal struct IO_COUNTERS {
        internal ulong ReadOperationCount,WriteOperationCount,OtherOperationCount;
        internal ulong ReadTransferCount,WriteTransferCount,OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        internal long TotalUserTime,TotalKernelTime,ThisPeriodUserTime,ThisPeriodKernelTime;
        internal uint TotalPageFaults,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;internal nuint ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll",SetLastError=true)]internal static extern nint CreateJobObject(nint security,string? name);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(nint job,int info,ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION value,int size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]internal static extern nint CreateFile(
        string path,uint access,uint share,ref SECURITY_ATTRIBUTES security,uint creation,uint flags,nint template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcess(string application,StringBuilder command,nint processSecurity,
        nint threadSecurity,bool inheritHandles,uint flags,nint env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(nint job,nint process);
    [DllImport("kernel32.dll",SetLastError=true)]internal static extern uint ResumeThread(nint thread);
    [DllImport("kernel32.dll",SetLastError=true)]internal static extern uint WaitForSingleObject(nint handle,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(nint handle,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(nint job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObject(nint job,int info,out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value,int length,nint returnLength);
    [DllImport("kernel32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);
}
