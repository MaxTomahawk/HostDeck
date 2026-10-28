using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using WindowsCommander.Core.Models;
using WindowsCommander.Windows.Services;

namespace HostDeck.DesktopWorker;

internal sealed class WorkerError(string code) : Exception(code);

internal static class Program
{
    [STAThread]
    private static async Task Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        // Private read-only file metadata/ACL transport. Reuse one bounded
        // stdio worker for batches; no public MCP or desktop operation added.
        if (args.Length == 1 && args[0] == "--fulltext-native") {
            await FullTextNative.Run();
            return;
        }
        if (args.Length == 1 && args[0] == "--everything") {
            try {
                var ipcLine = Console.In.ReadLine();
                if (ipcLine is null || ipcLine.Length > 65536) throw new WorkerError("EVERYTHING_INVALID_ARGUMENTS");
                using var request = JsonDocument.Parse(ipcLine);
                Console.Out.WriteLine(JsonSerializer.Serialize(new { result = EverythingIpc.Execute(request.RootElement) }));
            } catch (Exception error) {
                var code = error is WorkerError known && known.Message.StartsWith("EVERYTHING_", StringComparison.Ordinal)
                    ? known.Message : "EVERYTHING_UNAVAILABLE";
                Console.Out.WriteLine(JsonSerializer.Serialize(new { error = code }));
            }
            return;
        }
        // The launching user executor owns both pipe ends. No TCP listener or
        // service-side desktop injection is available in this process.
        if (args.Length == 2 && args[0] == "--job-status") {
            Console.Out.WriteLine(JsonSerializer.Serialize(new { status = JobStatus.Check(args[1]) }));
            return;
        }
        if (args.Length == 2 && args[0] == "--run-job") {
            await JobRunner.Run(args[1]);
            return;
        }
        if (args.Length == 2 && args[0] == "--verify-enrollment") {
            Console.Out.WriteLine(JsonSerializer.Serialize(await EnrollmentVerifier.Verify(args[1])));
            return;
        }
        if (args.Length != 1) return;
        if (args[0] == "--identity") {
            Console.Out.WriteLine(JsonSerializer.Serialize(DesktopWorker.Identity()));
            return;
        }
        if (args[0] != "--stdio") return;
        var worker = new DesktopWorker();
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            object response;
            string? id = null;
            try
            {
                // Rich clipboard artifact bytes are base64 encoded on this
                // private pipe. 26 MiB covers the 16 MiB decoded cap.
                if (line.Length > 26 * 1024 * 1024) throw new WorkerError("INVALID_ARGUMENTS");
                using var document = JsonDocument.Parse(line);
                var request = document.RootElement;
                id = request.GetProperty("id").GetString();
                if (string.IsNullOrEmpty(id) || id.Length > 128) throw new WorkerError("INVALID_ARGUMENTS");
                var operation = request.GetProperty("operation").GetString() ?? "";
                var arguments = request.GetProperty("args");
                response = new { id, result = await worker.Dispatch(operation, arguments) };
            }
            catch (Exception error)
            {
                var code = error is WorkerError known ? known.Message : "DESKTOP_UNAVAILABLE";
                response = new { id, error = new { code } };
            }
            Console.Out.WriteLine(JsonSerializer.Serialize(response));
            await Console.Out.FlushAsync();
        }
    }
}

internal sealed class DesktopWorker
{
    private readonly WindowService windows = new();
    private readonly ScreenService screens = new();
    private readonly UiAutomationService ui = new();
    private readonly InputService input = new();
    private readonly VisionService vision = new();
    private readonly ClipboardService clipboard = new();
    private readonly InteractiveProcesses processes = new();
    private readonly Dictionary<string, WindowReference> windowIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Raw, string WindowId)> elementIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> monitorIds = new(StringComparer.Ordinal);
    private const int MaxElements = 500;

    public async Task<object> Dispatch(string operation, JsonElement args)
    {
        if (operation == "hostdeck_internal_identity") return Identity();
        GuardSession(args);
        if (operation is "hostdeck_start_process" or "hostdeck_read_process" or "hostdeck_interact_process" or "hostdeck_terminate_process")
            return await processes.DispatchAsync(operation, args);
        switch (operation)
        {
            case "hostdeck_list_windows":
                windowIds.Clear(); elementIds.Clear();
                return new { windows = windows.ListWindows().Take(200).Select(w => new {
                    window_id = TryRegisterWindow((long)w.HWND), title = w.Title,
                    process_id = w.OwningPID, minimized = w.IsMinimized, bounds = Bounds(w.BoundingRect)
                }).Where(w => w.window_id is not null).ToArray() };
            case "hostdeck_display_metrics":
                monitorIds.Clear();
                return new { monitors = screens.GetScreenDetails().Take(32).Select(m => new {
                    monitor_id = RegisterMonitor(m.MonitorId), primary = m.IsPrimary,
                    bounds = Bounds(m.Bounds), working_area = Bounds(m.WorkingArea), dpi_scale = m.DpiScale
                }).ToArray() };
            case "hostdeck_window_action":
            {
                var window = ResolveWindow(args);
                var action = args.GetProperty("action");
                var kind = Str(action, "kind");
                object result = kind switch {
                    "focus" => windows.FocusWindow(window),
                    "move_resize" => MoveResize(window, action.GetProperty("bounds")),
                    "minimize" or "maximize" or "restore" => windows.SetWindowState(window, kind),
                    "close" => new { completed = Native.PostMessage(new IntPtr(window), 0x0010, 0, 0) },
                    _ => throw new WorkerError("INVALID_ARGUMENTS")
                };
                return new { completed = Completed(result) };
            }
            case "hostdeck_read_ui_tree":
            {
                ui.ClearReferences(); elementIds.Clear();
                var windowId = Str(args, "window_id");
                var tree = ui.ReadUiTree(ResolveWindow(args), Math.Clamp(Int(args, "max_depth", 5), 1, 20),
                    interactableOnly: Bool(args, "interactable_only"));
                return new { elements = tree.Elements.Take(MaxElements).Select(e => PublicElement(e, windowId)).ToArray(),
                    truncated = tree.Truncated || tree.Elements.Count > MaxElements };
            }
            case "hostdeck_find_ui_element":
            {
                ui.ClearReferences(); elementIds.Clear();
                var windowId = Str(args, "window_id");
                var found = ui.FindUiElement(ResolveWindow(args), Optional(args, "name_contains"),
                    Optional(args, "automation_id"), Optional(args, "control_type"), null, false,
                    Math.Clamp(Int(args, "max_depth", 5), 1, 20));
                return new { elements = found.Take(MaxElements).Select(e => PublicElement(e, windowId)).ToArray(),
                    truncated = found.Count > MaxElements };
            }
            case "hostdeck_invoke_ui_element":
            {
                var raw = ResolveElement(args);
                var action = Str(args, "action");
                if (!new[] { "invoke", "select", "expand", "collapse", "toggle", "focus" }.Contains(action))
                    throw new WorkerError("INVALID_ARGUMENTS");
                return new { completed = ui.InvokeUiElement(raw, action).Completed };
            }
            case "hostdeck_set_ui_value":
                return new { completed = ui.SetUiValue(ResolveElement(args), Str(args, "value")).Completed };
            case "hostdeck_type_text":
            {
                var window = ResolveWindow(args);
                FocusAndVerify(window);
                var value = Str(args, "text");
                if (value.Length > 100_000) throw new WorkerError("INVALID_ARGUMENTS");
                return new { completed = (await input.TypeTextAsync(value, null, CancellationToken.None)).Completed };
            }
            case "hostdeck_send_keys":
            {
                var window = ResolveWindow(args);
                FocusAndVerify(window);
                var modifiers = args.TryGetProperty("modifiers", out var mods)
                    ? mods.EnumerateArray().Select(m => m.GetString() ?? "").ToArray() : [];
                if (modifiers.Length > 4 || modifiers.Any(m => !new[] { "ctrl", "alt", "shift", "win" }.Contains(m)))
                    throw new WorkerError("INVALID_ARGUMENTS");
                return new { completed = input.SendHotkey(modifiers, Str(args, "key")).Completed };
            }
            case "hostdeck_mouse_action":
                return Mouse(args);
            case "hostdeck_capture_screen":
                return Capture(args);
            case "hostdeck_ocr_screen":
            {
                var window = ResolveWindow(args);
                RectBounds? region = args.TryGetProperty("region", out var r) ? Rect(r) : null;
                if (region is not null) RequireRegionWithin(window, region);
                OcrResult result;
                try { result = await vision.OcrScreenAsync("window", window, region); }
                catch (OcrLanguageUnavailableException) { throw new WorkerError("OCR_LANGUAGE_UNAVAILABLE"); }
                return new { text = result.CombinedText, blocks = result.Blocks.Take(500).Select(b => new {
                    text = b.Text, bounds = Bounds(b.Bounds), confidence = (double?)null
                }).ToArray(), confidence = (double?)null, confidence_status = "unmeasured",
                    recognizer_language = vision.RecognizerLanguageTag, language_coverage = "not_verified",
                    region = Bounds(result.Region) };
            }
            case "hostdeck_read_clipboard":
                return ClipboardRich.Read(Optional(args, "format") ?? "text");
            case "hostdeck_write_clipboard":
                return new { completed = clipboard.Access("write", Str(args, "text"), "text") is not null };
            case "hostdeck_write_clipboard_artifact":
                return ClipboardRich.WriteArtifact(Str(args, "format"), Str(args, "internal_data_base64"));
            default:
                throw new WorkerError("UNKNOWN_OPERATION");
        }
    }

    internal static object Identity()
    {
        var current = WindowsIdentity.GetCurrent();
        var session = Process.GetCurrentProcess().SessionId;
        return new { sid = current.User?.Value, account = current.Name,
            logon_id = Native.LogonId(), session_id = session, elevated = Native.IsElevated(),
            integrity = Native.Integrity(), input_desktop = Native.InputDesktopName(),
            window_station = Native.DesktopName(Native.GetProcessWindowStation()),
            eligible = session > 0 && !Native.IsElevated() && Native.Integrity() == "medium"
                && Native.InputDesktopName() == "Default"
                && Native.DesktopName(Native.GetProcessWindowStation()) == "WinSta0" };
    }

    private object Mouse(JsonElement args)
    {
        var window = ResolveWindow(args);
        FocusAndVerify(window);
        var action = args.GetProperty("action");
        var kind = Str(action, "kind");
        if (kind == "scroll") {
            var pos = action.GetProperty("position");
            RequireWithin(window, Int(pos, "x"), Int(pos, "y"));
            var delta = Int(action, "delta");
            if (Math.Abs(delta) > 10000) throw new WorkerError("INVALID_ARGUMENTS");
            return new { completed = input.MouseWheel(delta < 0 ? "down" : "up", Math.Abs(delta), window,
                Int(pos, "x"), Int(pos, "y")).Completed };
        }
        var point = kind == "drag" ? action.GetProperty("from") : action.GetProperty("position");
        var x = Int(point, "x"); var y = Int(point, "y");
        RequireWithin(window, x, y);
        if (kind == "drag") {
            var to = action.GetProperty("to");
            RequireWithin(window, Int(to, "x"), Int(to, "y"));
            input.MouseAction("move", null, x, y, window);
            return new { completed = input.MouseAction("drag", Optional(action, "button") ?? "left",
                Int(to, "x"), Int(to, "y"), window).Completed };
        }
        if (kind is not ("move" or "click" or "double_click")) throw new WorkerError("INVALID_ARGUMENTS");
        return new { completed = input.MouseAction(kind, Optional(action, "button") ?? "left", x, y, window).Completed };
    }

    private object Capture(JsonElement args)
    {
        var target = args.GetProperty("target");
        var max = Math.Clamp(Int(args, "max_dimension", 1400), 1, 8192);
        ScreenCaptureResult result;
        switch (Str(target, "kind")) {
            case "window": result = vision.CaptureScreen("window", ResolveWindowId(Str(target, "window_id")), max); break;
            case "screen":
                if (!monitorIds.TryGetValue(Str(target, "monitor_id"), out var source)) throw new WorkerError("STALE_MONITOR");
                var monitor = screens.GetScreenDetails().SingleOrDefault(m => m.MonitorId == source)
                    ?? throw new WorkerError("STALE_MONITOR");
                result = vision.CaptureScreenRegion(monitor.Bounds.X, monitor.Bounds.Y,
                    monitor.Bounds.Width, monitor.Bounds.Height, source, max); break;
            case "region":
                var region = Rect(target.GetProperty("bounds"));
                if (region.Width < 1 || region.Height < 1 || region.Width > 32768 || region.Height > 32768
                    || (long)region.Width * region.Height > 16_000_000) throw new WorkerError("INVALID_ARGUMENTS");
                result = vision.CaptureScreenRegion(region.X, region.Y, region.Width, region.Height, null, max); break;
            default: throw new WorkerError("INVALID_ARGUMENTS");
        }
        return new { png_base64 = result.PngBase64, mime_type = "image/png", bounds = Bounds(result.Region),
            captured_at = result.CapturedAt };
    }

    private object PublicElement(UiElementInfo value, string windowId)
    {
        var id = NewId();
        elementIds[id] = (value.ElementRef, windowId);
        return new { element_ref = id, name = value.Name, automation_id = value.AutomationId,
            control_type = value.ControlType, class_name = value.ClassName, bounds = Bounds(value.Bounds),
            enabled = value.IsEnabled, offscreen = value.IsOffscreen, value = value.Value };
    }

    private string ResolveElement(JsonElement args)
    {
        var windowId = Str(args, "window_id");
        ResolveWindow(args);
        if (!elementIds.TryGetValue(Str(args, "element_ref"), out var item) || item.WindowId != windowId)
            throw new WorkerError("STALE_ELEMENT");
        return item.Raw;
    }

    private string? TryRegisterWindow(long handle)
    {
        try {
            Native.GetWindowThreadProcessId(new IntPtr(handle), out var pid);
            if (pid == 0) return null;
            var id = NewId();
            windowIds[id] = new WindowReference(handle, pid, Process.GetProcessById((int)pid).StartTime, DateTimeOffset.UtcNow);
            return id;
        } catch (Exception) { return null; }
    }
    private string RegisterMonitor(string source) { var id = NewId(); monitorIds[id] = source; return id; }
    private static string NewId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
    private long ResolveWindow(JsonElement args) => ResolveWindowId(Str(args, "window_id"));
    private long ResolveWindowId(string id)
    {
        if (!windowIds.TryGetValue(id, out var reference) || DateTimeOffset.UtcNow - reference.SeenAt > TimeSpan.FromMinutes(1))
            throw new WorkerError("STALE_WINDOW");
        if (!Native.IsWindow(new IntPtr(reference.Handle))) throw new WorkerError("STALE_WINDOW");
        Native.GetWindowThreadProcessId(new IntPtr(reference.Handle), out var pid);
        if (pid == 0 || pid != reference.Pid || Process.GetProcessById((int)pid).StartTime != reference.ProcessStart)
            throw new WorkerError("STALE_WINDOW");
        if (!Native.ProcessIdToSessionId(pid, out var session) || session != Process.GetCurrentProcess().SessionId)
            throw new WorkerError("WRONG_SESSION");
        return reference.Handle;
    }

    private void FocusAndVerify(long window)
    {
        GuardDesktop();
        if (!windows.FocusWindow(window).Completed || windows.GetForegroundWindow()?.HWND != (nint)window)
            throw new WorkerError("WINDOW_NOT_FOREGROUND");
        GuardDesktop();
    }

    private void RequireWithin(long window, int x, int y)
    {
        var bounds = windows.FindWindows(null, null, null, null, false)
            .FirstOrDefault(w => (long)w.HWND == window)?.BoundingRect ?? throw new WorkerError("STALE_WINDOW");
        if (x < bounds.X || y < bounds.Y || x >= (long)bounds.X + bounds.Width || y >= (long)bounds.Y + bounds.Height)
            throw new WorkerError("OUTSIDE_WINDOW");
    }

    private void RequireRegionWithin(long window, RectBounds region)
    {
        if (region.Width < 1 || region.Height < 1 || (long)region.Width * region.Height > 16_000_000)
            throw new WorkerError("INVALID_ARGUMENTS");
        RequireWithin(window, region.X, region.Y);
        RequireWithin(window, checked(region.X + region.Width - 1), checked(region.Y + region.Height - 1));
    }

    private static void GuardSession(JsonElement args)
    {
        if (!args.TryGetProperty("session_id", out var requested) || !requested.TryGetInt32(out var session)
            || session <= 0 || session != Process.GetCurrentProcess().SessionId) throw new WorkerError("WRONG_SESSION");
        if (Native.IsElevated() || Native.Integrity() != "medium") throw new WorkerError("ELEVATED_WORKER");
        GuardDesktop();
    }

    private static void GuardDesktop()
    {
        if (!Native.SessionUnlocked()) throw new WorkerError("SECURE_DESKTOP");
        var station = Native.GetProcessWindowStation();
        var current = Native.GetThreadDesktop(Native.GetCurrentThreadId());
        var active = Native.OpenInputDesktop(0, false, 0x0001);
        try {
            if (station == 0 || Native.DesktopName(station) != "WinSta0" ||
                current == 0 || active == 0 || Native.DesktopName(current) != "Default"
                || Native.DesktopName(active) != "Default") throw new WorkerError("SECURE_DESKTOP");
        } finally { if (active != 0) Native.CloseDesktop(active); }
    }

    private static object MoveResize(long handle, JsonElement value)
    {
        var rect = Rect(value);
        return new WindowService().MoveResizeWindow(handle, rect.X, rect.Y, rect.Width, rect.Height);
    }
    private static bool Completed(object result) => result is WindowActionResult r ? r.Completed :
        result.GetType().GetProperty("completed")?.GetValue(result) is true;
    private static object Bounds(RectBounds r) => new { x = r.X, y = r.Y, width = r.Width, height = r.Height };
    private static RectBounds Rect(JsonElement r) => new(Int(r, "x"), Int(r, "y"), Int(r, "width"), Int(r, "height"));
    private static string Str(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new WorkerError("INVALID_ARGUMENTS");
    private static string? Optional(JsonElement value, string key) => value.TryGetProperty(key, out var v) ? v.GetString() : null;
    private static int Int(JsonElement value, string key, int fallback = 0) => value.TryGetProperty(key, out var v) ? v.GetInt32() : fallback;
    private static bool Bool(JsonElement value, string key) => value.TryGetProperty(key, out var v) && v.GetBoolean();
    private sealed record WindowReference(long Handle, uint Pid, DateTime ProcessStart, DateTimeOffset SeenAt);
}

internal static class Native
{
    // WTSINFOEXW (Win10+): DWORD Level, 4 bytes padding, 224-byte
    // WTSINFOEX_LEVEL1_W union data. SessionId/State/Flags start at 8/12/16.
    // Only the fixed-size, versioned and same-session Level 1 result is trusted.
    [StructLayout(LayoutKind.Explicit, Size = 232)]
    private struct WtsInfoExLevel1W
    {
        [FieldOffset(0)] public int Level;
        [FieldOffset(8)] public uint SessionId;
        [FieldOffset(12)] public int SessionState;
        [FieldOffset(16)] public int SessionFlags;
    }

    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQuerySessionInformation(nint server, uint sessionId, int infoClass,
        out nint buffer, out uint bytesReturned);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(nint buffer);

    internal static bool SessionUnlocked()
    {
        var sessionId = Process.GetCurrentProcess().SessionId;
        if (sessionId <= 0) return false;
        nint buffer = nint.Zero;
        try
        {
            // WTS_CURRENT_SERVER_HANDLE = NULL; WTSSessionInfoEx = 25.
            var queried = WTSQuerySessionInformation(nint.Zero, (uint)sessionId, 25, out buffer, out var bytesReturned);
            return IsUnlockedWtsInfoEx(queried, buffer, bytesReturned, (uint)sessionId);
        }
        finally
        {
            if (buffer != nint.Zero) WTSFreeMemory(buffer);
        }
    }

    // Pure decision seam for malformed/failed native-buffer regressions.
    internal static bool IsUnlockedWtsInfoEx(bool queried, nint buffer, uint bytesReturned, uint expectedSession)
    {
        if (!queried || expectedSession == 0 || buffer == nint.Zero ||
            bytesReturned < (uint)Marshal.SizeOf<WtsInfoExLevel1W>()) return false;
        var info = Marshal.PtrToStructure<WtsInfoExLevel1W>(buffer);
        // WTSActive = 0; WTS_SESSIONSTATE_UNLOCK = 1. LOCK=0/UNKNOWN=-1 fail closed.
        return info.Level == 1 && info.SessionId == expectedSession &&
            info.SessionState == 0 && info.SessionFlags == 1;
    }

    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr window, uint message, nint wParam, nint lParam);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] internal static extern nint GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] internal static extern nint GetProcessWindowStation();
    [DllImport("user32.dll")] internal static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] internal static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder buffer, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(nint token, int infoClass, out int value, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(nint token, int infoClass, nint value, int length, out int needed);
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    internal static string DesktopName(nint handle)
    {
        var buffer = new StringBuilder(256);
        return GetUserObjectInformation(handle, 2, buffer, buffer.Capacity * sizeof(char), out _) ? buffer.ToString() : "";
    }
    internal static bool IsElevated()
    {
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out var token)) return true;
        try { return !GetTokenInformation(token, 20, out var elevation, sizeof(int), out _) || elevation != 0; }
        finally { CloseHandle(token); }
    }
    internal static string InputDesktopName()
    {
        var desktop = OpenInputDesktop(0, false, 0x0001);
        try { return desktop == 0 ? "unavailable" : DesktopName(desktop); }
        finally { if (desktop != 0) CloseDesktop(desktop); }
    }
    internal static string LogonId()
    {
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out var token)) return "unavailable";
        try { return TokenLogonId(token); }
        finally { CloseHandle(token); }
    }
    internal static string TokenLogonId(nint token)
    {
            var size = Marshal.SizeOf<TokenStatistics>();
            var buffer = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 10, buffer, size, out _)) return "unavailable";
                var value = Marshal.PtrToStructure<TokenStatistics>(buffer);
                return $"{value.AuthenticationId.HighPart:x8}{value.AuthenticationId.LowPart:x8}";
            } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static string Integrity()
    {
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out var token)) return "unavailable";
        try {
            GetTokenInformation(token, 25, 0, 0, out var size);
            if (size < IntPtr.Size || size > 4096) return "unavailable";
            var buffer = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 25, buffer, size, out _)) return "unavailable";
                var sid = Marshal.ReadIntPtr(buffer);
                var count = Marshal.ReadByte(sid, 1);
                if (count < 1) return "unavailable";
                var rid = Marshal.ReadInt32(sid, 8 + 4 * (count - 1));
                return rid switch { < 0x1000 => "untrusted", < 0x2000 => "low", < 0x3000 => "medium",
                    < 0x4000 => "high", _ => "system" };
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally { CloseHandle(token); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenStatistics {
        public Luid TokenId; public Luid AuthenticationId; public long ExpirationTime;
        public int TokenType; public int ImpersonationLevel; public uint DynamicCharged;
        public uint DynamicAvailable; public uint GroupCount; public uint PrivilegeCount;
        public Luid ModifiedId;
    }
}
