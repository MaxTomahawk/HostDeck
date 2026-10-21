using Microsoft.Win32.SafeHandles;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace HostDeck.DesktopWorker;

// Process ids are opaque random handles scoped to this stdio worker. Every
// child is assigned to a kill-on-close Job Object before it can execute.
internal sealed class InteractiveProcesses
{
    private const int OutputLimit = 1024 * 1024;
    private const int ProcessLimit = 32;
    private readonly ConcurrentDictionary<string, ProcessRecord> _records = new();

    internal async Task<object> DispatchAsync(string operation, JsonElement args)
    {
        return operation switch {
            "hostdeck_start_process" => await Start(args),
            "hostdeck_read_process" => await Read(args),
            "hostdeck_interact_process" => await Interact(args),
            "hostdeck_terminate_process" => Terminate(args),
            _ => throw new WorkerError("UNKNOWN_OPERATION")
        };
    }

    private async Task<object> Start(JsonElement args)
    {
        var command = String(args, "command");
        var shell = String(args, "shell").ToLowerInvariant();
        var executable = String(args, "shell_executable");
        var cwd = String(args, "cwd");
        if (command.Length is 0 or > 100_000 || !Path.IsPathFullyQualified(executable) || !File.Exists(executable)
            || !Path.IsPathFullyQualified(cwd) || !Directory.Exists(cwd)
            || !new[] { "powershell", "cmd" }.Contains(shell)
            || !new[] { "powershell.exe", "pwsh.exe", "cmd.exe" }.Contains(Path.GetFileName(executable), StringComparer.OrdinalIgnoreCase))
            throw new WorkerError("INVALID_ARGUMENTS");
        if (_records.Count >= ProcessLimit) foreach (var old in _records.Where(x => x.Value.Closed).Take(_records.Count - ProcessLimit + 1).ToArray()) { _records.TryRemove(old.Key, out _); old.Value.Dispose(); }
        if (_records.Count >= ProcessLimit) throw new WorkerError("LIMIT_EXCEEDED");
        var id = Guid.NewGuid().ToString("N");
        var record = CreateProcess(id, command, shell, executable, cwd);
        if (!_records.TryAdd(id, record)) { record.Dispose(); throw new WorkerError("DESKTOP_UNAVAILABLE"); }
        record.StartPumps();
        await Observe(record, Timeout(args, "timeout_ms", 10_000));
        return Snapshot(record, 0, 1000);
    }

    private async Task<object> Read(JsonElement args)
    {
        var record = Get(args);
        await Observe(record, Timeout(args, "timeout_ms", 1000));
        return Snapshot(record, Int(args, "offset", 0), Math.Clamp(Int(args, "limit", 1000), 1, 10_000));
    }

    private async Task<object> Interact(JsonElement args)
    {
        var record = Get(args);
        var input = String(args, "input");
        if (Encoding.UTF8.GetByteCount(input) > 100_000) throw new WorkerError("INVALID_ARGUMENTS");
        if (record.Closed) throw new WorkerError("PROCESS_CLOSED");
        if (!await record.InputLock.WaitAsync(0)) throw new WorkerError("INPUT_BUSY");
        var delivery = "uncertain";
        try {
            var timeout = Timeout(args, "timeout_ms", 1000);
            using var deadline = new CancellationTokenSource(timeout);
            try { await record.Input.WriteAsync(Encoding.UTF8.GetBytes(input), deadline.Token); await record.Input.FlushAsync(deadline.Token); delivery = "written_to_pipe"; }
            catch (OperationCanceledException) { }
            catch (IOException) { throw new WorkerError("PROCESS_CLOSED"); }
            if (delivery == "written_to_pipe") await Observe(record, Math.Max(0, timeout - 20));
        } finally { record.InputLock.Release(); }
        var result = (Dictionary<string, object?>)Snapshot(record, 0, 1000); result["input_delivery"] = delivery; result["retry_safe"] = false; return result;
    }

    private object Terminate(JsonElement args)
    {
        var record = Get(args);
        var action = Optional(args, "action") ?? "terminate";
        if (action is not ("interrupt" or "terminate")) throw new WorkerError("INVALID_ARGUMENTS");
        if (!record.Closed && !JobNative.TerminateJobObject(record.Job, 1)) throw new WorkerError("DESKTOP_UNAVAILABLE");
        var deadline = Environment.TickCount64 + 5000;
        while (!record.Closed && Environment.TickCount64 < deadline) { record.RefreshExit(); if (!record.Closed) Thread.Sleep(25); }
        record.RefreshExit();
        var contained = record.HasNoActiveProcesses();
        return new { process_id = record.Id, state = record.Closed ? "exited" : "running", terminated = record.Closed && contained, descendants_contained = contained };
    }

    private ProcessRecord Get(JsonElement args)
    {
        var id = String(args, "process_id");
        return _records.TryGetValue(id, out var record) ? record : throw new WorkerError("UNKNOWN_PROCESS");
    }

    private static async Task Observe(ProcessRecord record, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + Math.Clamp(timeoutMs, 0, 300_000);
        do {
            record.RefreshExit();
            if (record.Closed || Environment.TickCount64 >= deadline) return;
            await Task.Delay(25);
        } while (true);
    }

    private static object Snapshot(ProcessRecord record, int offset, int limit)
    {
        record.RefreshExit();
        string output; bool truncated; int exitCode;
        lock (record.OutputLock) { output = record.Output.ToString(); truncated = record.Truncated; exitCode = record.ExitCode; }
        var lines = output.Length == 0 ? Array.Empty<string>() : output.Split("\r\n", StringSplitOptions.None).SelectMany(x => x.Split('\n')).ToArray();
        if (output.EndsWith('\n')) lines = lines.Take(lines.Length - 1).ToArray();
        var start = Math.Min(lines.Length, Math.Max(0, offset < 0 ? lines.Length + offset : offset));
        var selected = lines.Skip(start).Take(limit).ToArray();
        var partial = !record.Closed && output.Length > 0 && !output.EndsWith('\n') && selected.Length > 0 && start + selected.Length == lines.Length;
        return new Dictionary<string, object?> { ["process_id"] = record.Id, ["state"] = record.Closed ? "exited" : "running", ["exit_code"] = record.Closed ? exitCode : null,
            ["output"] = string.Join("\n", selected), ["total_lines"] = lines.Length, ["offset"] = start,
            ["next_offset"] = start + selected.Length - (partial ? 1 : 0), ["partial_line"] = partial, ["output_truncated"] = truncated, ["retained"] = "prefix", ["pty"] = false };
    }

    private static ProcessRecord CreateProcess(string id, string command, string shell, string executable, string cwd)
    {
        var job = JobNative.CreateJobObject(0, null);
        if (job == 0) throw new WorkerError("DESKTOP_UNAVAILABLE");
        nint childStdout = 0, parentStdout = 0, childStderr = 0, parentStderr = 0, parentStdin = 0, childStdin = 0;
        JobNative.PROCESS_INFORMATION process = default;
        try {
            var limits = new JobNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = new JobNative.JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = 0x00002000 } };
            if (!JobNative.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf<JobNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())) throw new WorkerError("DESKTOP_UNAVAILABLE");
            var security = new InteractiveNative.SECURITY_ATTRIBUTES { Length = Marshal.SizeOf<InteractiveNative.SECURITY_ATTRIBUTES>(), Inherit = true };
            if (!InteractiveNative.CreatePipe(out childStdin, out parentStdin, ref security, 0)
                || !InteractiveNative.CreatePipe(out parentStdout, out childStdout, ref security, 0)
                || !InteractiveNative.CreatePipe(out parentStderr, out childStderr, ref security, 0)) throw new WorkerError("DESKTOP_UNAVAILABLE");
            if (!InteractiveNative.SetHandleInformation(parentStdin, 1, 0) || !InteractiveNative.SetHandleInformation(parentStdout, 1, 0) || !InteractiveNative.SetHandleInformation(parentStderr, 1, 0)) throw new WorkerError("DESKTOP_UNAVAILABLE");
            var startup = new JobNative.STARTUPINFO { cb = Marshal.SizeOf<JobNative.STARTUPINFO>(), dwFlags = 0x00000100, hStdInput = childStdin, hStdOutput = childStdout, hStdError = childStderr };
            var line = CommandLine(shell, executable, command);
            if (!JobNative.CreateProcess(executable, line, 0, 0, true, 0x00000004 | 0x08000000 | 0x00000400, 0, cwd, ref startup, out process)) throw new WorkerError("DESKTOP_UNAVAILABLE");
            if (!JobNative.AssignProcessToJobObject(job, process.hProcess) || JobNative.ResumeThread(process.hThread) == uint.MaxValue) throw new WorkerError("DESKTOP_UNAVAILABLE");
            foreach (var handle in new[] { childStdin, childStdout, childStderr }) InteractiveNative.CloseHandle(handle);
            childStdin = childStdout = childStderr = 0;
            var input = new FileStream(new SafeFileHandle((IntPtr)parentStdin, true), FileAccess.Write, 4096, false); parentStdin = 0;
            var stdout = new FileStream(new SafeFileHandle((IntPtr)parentStdout, true), FileAccess.Read, 4096, false); parentStdout = 0;
            var stderr = new FileStream(new SafeFileHandle((IntPtr)parentStderr, true), FileAccess.Read, 4096, false); parentStderr = 0;
            var record = new ProcessRecord(id, job, process.hProcess, input, stdout, stderr); job = 0; process.hProcess = 0;
            InteractiveNative.CloseHandle(process.hThread); process.hThread = 0;
            return record;
        } catch {
            if (job != 0) { JobNative.TerminateJobObject(job, 1); JobNative.CloseHandle(job); }
            if (process.hThread != 0) InteractiveNative.CloseHandle(process.hThread);
            if (process.hProcess != 0) InteractiveNative.CloseHandle(process.hProcess);
            foreach (var h in new[] { childStdin, parentStdin, childStdout, parentStdout, childStderr, parentStderr }) if (h != 0 && h != -1) InteractiveNative.CloseHandle(h);
            throw;
        }
    }

    private static StringBuilder CommandLine(string shell, string executable, string command)
    {
        var file = Path.GetFileName(executable).ToLowerInvariant();
        var args = file switch {
            "powershell.exe" or "pwsh.exe" when shell == "powershell" => "-NoLogo -NoProfile -OutputFormat Text -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[Text.UTF8Encoding]::new($false);\n" + command)),
            "cmd.exe" when shell == "cmd" => "/d /q /c " + Quote(command),
            _ => throw new WorkerError("INVALID_ARGUMENTS")
        };
        return new StringBuilder('"' + executable + '"' + " " + args);
    }
    private static string Quote(string value) => '"' + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + '"';
    private static string String(JsonElement args, string name) => args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : throw new WorkerError("INVALID_ARGUMENTS");
    private static string? Optional(JsonElement args, string name) => args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static int Int(JsonElement args, string name, int fallback) => args.TryGetProperty(name, out var v) && v.TryGetInt32(out var result) ? result : fallback;
    private static int Timeout(JsonElement args, string name, int fallback) => Math.Clamp(Int(args, name, fallback), 0, 300_000);

    private sealed class ProcessRecord(string id, nint job, nint process, FileStream input, FileStream stdout, FileStream stderr) : IDisposable
    {
        internal string Id { get; } = id; internal nint Job { get; } = job; internal nint Process { get; } = process;
        internal FileStream Input { get; } = input; internal SemaphoreSlim InputLock { get; } = new(1, 1);
        internal StringBuilder Output { get; } = new(); internal object OutputLock { get; } = new(); internal bool Truncated; internal bool Closed; internal bool RootExited; internal int PumpsClosed; internal int ExitCode; internal TaskCompletionSource ClosedSignal { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal void StartPumps() { _ = Pump(stdout); _ = Pump(stderr); }
        private async Task Pump(Stream stream) { var buffer = new byte[8192]; try { while (true) { var count = await stream.ReadAsync(buffer); if (count == 0) break; lock (OutputLock) { var room = OutputLimit - Encoding.UTF8.GetByteCount(Output.ToString()); if (room <= 0) { Truncated = true; continue; } var take = Math.Min(room, count); if (take < count) Truncated = true; Output.Append(Encoding.UTF8.GetString(buffer, 0, take)); } } } catch (IOException) { } finally { try { await stream.DisposeAsync(); } catch { } Interlocked.Increment(ref PumpsClosed); RefreshExit(); } }
        internal bool HasNoActiveProcesses() => JobNative.QueryInformationJobObject(Job, 1, out var info, Marshal.SizeOf<JobNative.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), 0) && info.ActiveProcesses == 0;
        internal void RefreshExit() {
            if (Closed) return;
            if (!RootExited && JobNative.WaitForSingleObject(Process, 0) == 0) {
                if (JobNative.GetExitCodeProcess(Process, out var code)) ExitCode = unchecked((int)code);
                RootExited = true; try { Input.Dispose(); } catch { }
            }
            if (RootExited && HasNoActiveProcesses() && Volatile.Read(ref PumpsClosed) == 2) { Closed = true; ClosedSignal.TrySetResult(); }
        }
        public void Dispose() { try { JobNative.CloseHandle(Job); } catch { } try { JobNative.CloseHandle(Process); } catch { } try { Input.Dispose(); } catch { } }
    }
}

internal static class InteractiveNative
{
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { internal int Length; internal nint Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out nint read, out nint write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(nint handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(nint handle);
}
