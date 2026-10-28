using System.Buffers.Binary;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace HostDeck.DesktopWorker;

// Local IPC2 interoperability, based on the documented voidtools wire contract.
// No vendor DLL, service mutation, query history mutation or network endpoint.
internal static class EverythingIpc
{
    private const string WindowClass = "EVERYTHING_TASKBAR_NOTIFICATION";
    private const int MaxItems = 100_001, MaxReplyBytes = 16 * 1024 * 1024;
    // voidtools/ES src/everything_ipc.h: MATCHPATH=0x04, REGEX=0x08.
    private const uint IpcMatchPath = 0x04, IpcRegex = 0x08;
    private static string Text(JsonElement r, string key) => r.GetProperty(key).GetString() ?? throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
    internal static object Execute(JsonElement r)
    {
        var identity = JsonSerializer.SerializeToElement(DesktopWorker.Identity());
        var session = r.GetProperty("session_id").GetInt32();
        if (session <= 0 || session != Process.GetCurrentProcess().SessionId || Native.IsElevated()
            || !identity.GetProperty("eligible").GetBoolean() || Text(identity, "sid") != Text(r, "sid")
            || Text(identity, "logon_id") != Text(r, "logon_id")) throw new WorkerError("EVERYTHING_WRONG_SESSION");
        var executable = Text(r, "executable");
        if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable)) throw new WorkerError("EVERYTHING_NOT_INSTALLED");
        executable = Path.GetFullPath(executable);
        using (var file = File.OpenRead(executable))
            if (!Convert.ToHexString(SHA256.HashData(file)).Equals(Text(r, "sha256"), StringComparison.OrdinalIgnoreCase))
                throw new WorkerError("EVERYTHING_BINARY_CHANGED");
        var version = FileVersionInfo.GetVersionInfo(executable).FileVersion ?? "";
        if (version != Text(r, "version") || !(version.StartsWith("1.4.", StringComparison.Ordinal) || version.StartsWith("1.5.", StringComparison.Ordinal)))
            throw new WorkerError("EVERYTHING_VERSION_UNSUPPORTED");
        var instance = Text(r, "instance");
        if (!Regex.IsMatch(instance, @"^[A-Za-z0-9_. -]{0,64}$")) throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
        var targetClass = WindowClass + (instance.Length == 0 ? "" : "_(" + instance + ")");
        var found = new List<nint>();
        EnumWindows((window, _) => {
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() == targetClass) found.Add(window);
            return true;
        }, 0);
        var operation = Text(r, "operation");
        if (operation is not ("status" or "query")) throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
        if (found.Count > 1) throw new WorkerError("EVERYTHING_INSTANCE_AMBIGUOUS");
        if (found.Count == 0) {
            if (operation == "query") throw new WorkerError("EVERYTHING_NOT_RUNNING");
            return Status(version, instance, session, false, false);
        }
        var target = found[0];
        Native.GetWindowThreadProcessId(target, out var pid);
        using var process = Process.GetProcessById(checked((int)pid));
        if (process.SessionId != session || !string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase))
            throw new WorkerError("EVERYTHING_TARGET_CHANGED");
        if (!OpenProcessToken(process.Handle, 8, out var token)) throw new WorkerError("EVERYTHING_TARGET_DENIED");
        try {
            ValidateTargetToken(token, Text(r,"sid"),Text(r,"logon_id"));
        } finally { CloseHandle(token); }
        var started = process.StartTime.ToUniversalTime().Ticks;
        var ready = Send(target, 0x400, 401, 0, 2000) != 0;
        if (operation == "status") return Status(version, instance, session, true, ready);
        if (!ready) throw new WorkerError("EVERYTHING_LOADING");
        var timeout = Math.Clamp(r.GetProperty("timeout_ms").GetInt32(), 1, 300_000);
        var root = Text(r, "root");
        var workspace = Text(r, "workspace");
        var needle = Text(r, "name_filter");
        var nameScope = Text(r, "name_scope");
        if (!Path.IsPathFullyQualified(root) || root.Length > 4096 ||
            !Path.IsPathFullyQualified(workspace) || workspace.Length > 4096 ||
            needle.Length is < 1 or > 256 || needle.Any(char.IsControl) ||
            nameScope is not ("workspace_relative" or "absolute"))
            throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
        // Only the workspace-relative contract requires root <= workspace.
        // Explicit external read scopes are authorized by the HostDeck adapter,
        // and match Node's absolute display path (including drive/ancestors).
        if (nameScope == "workspace_relative") {
            var relative = Path.GetRelativePath(workspace, root);
            if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                || Path.IsPathRooted(relative)) throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
        }
        // The Node adapter supplies only a mandatory literal fragment of its
        // validated name matcher, never Everything query syntax. Intersect it
        // with the existing root before the vendor applies MaxItems/offset 0.
        // Node still verifies basename OR workspace-relative name after ACL checks.
        var query = FilteredRootExpression(root, workspace, needle, nameScope);
        using var reply = new ReplyWindow(target);
        var search = Encoding.Unicode.GetBytes(query + '\0');
        var bytes = new byte[28 + search.Length];
        void Put(int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(at), value);
        Put(0, unchecked((uint)reply.Handle.ToInt64())); Put(4, reply.ReplyId);
        Put(8, IpcMatchPath | IpcRegex); Put(12, 0); Put(16, MaxItems); Put(20, 4); Put(24, 3);
        search.CopyTo(bytes, 28);
        var memory = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, memory, bytes.Length);
            var data = new CopyData { Id = 18, Size = bytes.Length, Data = memory };
            if (SendMessageTimeout(target, 0x4a, reply.Handle, ref data, 2, (uint)Math.Min(timeout, 2000), out var accepted) == 0)
                throw new WorkerError("EVERYTHING_TIMEOUT");
            if (accepted == 0) throw new WorkerError("EVERYTHING_QUERY_UNSUPPORTED");
        } finally { Marshal.FreeHGlobal(memory); }
        var clock = Stopwatch.StartNew();
        while (reply.Bytes is null && reply.Error is null && clock.ElapsedMilliseconds < timeout) {
            Application.DoEvents(); Thread.Sleep(5);
        }
        if (reply.Error is not null) throw new WorkerError(reply.Error);
        if (reply.Bytes is null) throw new WorkerError("EVERYTHING_TIMEOUT");
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != started || !Native.IsWindow(target))
            throw new WorkerError("EVERYTHING_TARGET_CHANGED");
        return Parse(reply.Bytes, version, instance, session, pid + ":" + started);
    }
    private static string RootExpression(string root)
    {
        var normalized=Path.TrimEndingDirectorySeparator(root);
        return "^"+Regex.Escape(normalized)+(Path.EndsInDirectorySeparator(normalized)?"":@"(?:\\|$)");
    }
    private static string FilteredRootExpression(string root, string workspace,
        string needle, string nameScope)
    {
        // Both parts are PCRE literals. For workspace-relative names ignore
        // the workspace itself, but retain subfolders; for explicit readScope
        // the existing Node displayRead matches the FULL absolute path.
        // The final rootPrefix always limits the provider's match scope.
        var rootPrefix = RootExpression(root);
        var namePrefix = nameScope == "absolute" ? "" : RootExpression(workspace)[1..];
        return @"(?i)^(?=" + namePrefix + @"[\s\S]*" +
            Regex.Escape(needle) + ")" + rootPrefix[1..];
    }
    private static void ValidateTargetToken(nint token,string sid,string logon)
    {
        using var user=new WindowsIdentity(token);
        if(user.User?.Value!=sid||!GetTokenInformation(token,20,out var elevated,sizeof(int),out _)||elevated!=0||Native.TokenLogonId(token)!=logon)
            throw new WorkerError("EVERYTHING_TARGET_DENIED");
    }
    private static object Status(string version, string instance, int session, bool running, bool ready) => new {
        installed = true, enabled = true, running, compatible = true, healthy = ready,
        reason = !running ? "not_running" : ready ? "ready" : "loading", version, instance, session_id = session,
        qualified = "not_independently_accepted"
    };
    private static object Parse(byte[] bytes, string version, string instance, int session, string runtimeId)
    {
        if (bytes.Length < 20) throw new WorkerError("EVERYTHING_PROTOCOL_ERROR");
        uint Read(int at) => BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at, 4));
        var total = Read(0); var count = Read(4);
        if (count > MaxItems || Read(8) != 0 || Read(12) != 4 || 20L + count * 8L > bytes.Length)
            throw new WorkerError("EVERYTHING_PROTOCOL_ERROR");
        var paths = new List<string>();
        for (var i = 0; i < count; i++) {
            var offset = Read(20 + i * 8 + 4);
            if (offset < 20L + count * 8L || offset + 4L > bytes.Length) throw new WorkerError("EVERYTHING_PROTOCOL_ERROR");
            var length = Read((int)offset);
            if (length > 32768 || offset + 4L + (length + 1L) * 2 > bytes.Length) throw new WorkerError("EVERYTHING_PROTOCOL_ERROR");
            var value = Encoding.Unicode.GetString(bytes, (int)offset + 4, checked((int)length * 2));
            if (value.Contains('\0')) throw new WorkerError("EVERYTHING_PROTOCOL_ERROR");
            paths.Add(value);
        }
        // Never export the vendor's global count. HostDeck authorizes every hit.
        return new { paths, truncated = total > count, version, instance, session_id = session, runtime_id = runtimeId };
    }
    private static nint Send(nint target, uint message, nuint wParam, nint lParam, uint timeout)
    {
        if (SendMessageTimeout(target, message, wParam, lParam, 2, timeout, out var result) == 0) throw new WorkerError("EVERYTHING_TIMEOUT");
        return result;
    }
    private sealed class ReplyWindow : NativeWindow, IDisposable
    {
        internal uint ReplyId { get; } = 0x48444556;
        internal byte[]? Bytes; internal string? Error;
        private readonly nint target;
        internal ReplyWindow(nint target) { this.target = target; CreateHandle(new CreateParams { Caption = "HostDeck IPC reply", Parent = -3 }); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x4a && m.WParam == target) {
                var data = Marshal.PtrToStructure<CopyData>(m.LParam);
                if (data.Id == ReplyId) {
                    if (data.Size is < 20 or > MaxReplyBytes || data.Data == 0) Error = "EVERYTHING_RESPONSE_LIMIT";
                    else { Bytes = new byte[data.Size]; Marshal.Copy(data.Data, Bytes, 0, data.Size); }
                    m.Result = 1; return;
                }
            }
            base.WndProc(ref m);
        }
        public void Dispose() => DestroyHandle();
    }
    [StructLayout(LayoutKind.Sequential)] private struct CopyData { internal nuint Id; internal int Size; internal nint Data; }
    private delegate bool EnumCallback(nint window, nint parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, nint parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(nint window, StringBuilder name, int length);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SendMessageTimeout(nint window, uint message, nuint wParam, nint lParam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SendMessageTimeout(nint window, uint message, nint wParam, ref CopyData data, uint flags, uint timeout, out nint result);
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(nint token, int kind, out int value, int size, out int needed);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
}
