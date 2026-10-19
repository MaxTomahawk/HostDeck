using System.Diagnostics;
using System.Drawing;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Windows.Forms;

namespace HostDeck.Tray;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 3) return; // exact node.exe, facade entry, config
        if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return;
        var node = Path.GetFullPath(args[0]);
        var entry = Path.GetFullPath(args[1]);
        var config = Path.GetFullPath(args[2]);
        if (!File.Exists(node) || !File.Exists(entry) || !File.Exists(config)) return;
        using var singleton = new Mutex(true, $"Local\\HostDeck.Tray.{WindowsIdentity.GetCurrent().User?.Value}", out var owns);
        if (!owns) return;
        Application.Run(new TrayContext(node, entry, config));
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly string node;
    private readonly string entry;
    private readonly string config;
    private readonly string stateDirectory;
    private readonly NotifyIcon icon;
    private Process? agent;
    private readonly System.Windows.Forms.Timer heartbeat = new() { Interval = 30000 };

    internal TrayContext(string node, string entry, string config)
    {
        this.node = node; this.entry = entry; this.config = config;
        using (var document = JsonDocument.Parse(File.ReadAllText(config))) {
            stateDirectory = document.RootElement.GetProperty("state_directory").GetString()
                ?? throw new InvalidDataException("Missing state directory.");
        }
        if (!Path.IsPathFullyQualified(stateDirectory)) throw new InvalidDataException("State directory must be absolute.");
        var menu = new ContextMenuStrip();
        menu.Items.Add("Restart HostDeck agent", null, (_, _) => Restart());
        menu.Items.Add("Exit", null, (_, _) => ExitThread());
        icon = new NotifyIcon { Text = "HostDeck", Icon = SystemIcons.Application,
            ContextMenuStrip = menu, Visible = true };
        heartbeat.Tick += (_, _) => { Start(); RegisterWithService(); };
        heartbeat.Start();
        Start();
        RegisterWithService();
    }

    private void Start()
    {
        if (agent is { HasExited: false }) return;
        agent?.Dispose();
        agent = Process.Start(new ProcessStartInfo(node) {
            UseShellExecute = false, CreateNoWindow = true,
            ArgumentList = { entry, "--http", "--config", config }
        });
        icon.Text = agent is null ? "HostDeck agent unavailable" : "HostDeck agent running";
    }

    private void Restart()
    {
        Stop();
        Start();
    }

    private void RegisterWithService()
    {
        if (agent is not { HasExited: false }) return;
        try {
            using var pipe = new NamedPipeClientStream(".", "HostDeck.Service", PipeDirection.InOut);
            pipe.Connect(1000);
            if (!Native.IsTrustedService(pipe.SafePipeHandle)) throw new IOException("Untrusted service pipe.");
            using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
            using var reader = new StreamReader(pipe, leaveOpen: true);
            writer.WriteLine("{\"operation\":\"register\"}");
            _ = reader.ReadLine();
        } catch (IOException) { icon.Text = "HostDeck service unavailable"; }
          catch (TimeoutException) { icon.Text = "HostDeck service unavailable"; }
    }

    private void Stop()
    {
        if (agent is not { HasExited: false }) return;
        try {
            var controlPath = Path.Combine(stateDirectory, "agent-control.json");
            var stopPath = Path.Combine(stateDirectory, "agent-stop.json");
            using var control = JsonDocument.Parse(File.ReadAllText(controlPath));
            var generation = control.RootElement.GetProperty("generation").GetString();
            var pid = control.RootElement.GetProperty("pid").GetInt32();
            if (pid == agent.Id && Guid.TryParse(generation, out _)) {
                var temporary = stopPath + "." + Guid.NewGuid().ToString("N");
                File.WriteAllText(temporary, JsonSerializer.Serialize(new { generation }));
                File.Move(temporary, stopPath, true);
                agent.WaitForExit(5000);
            }
        } catch (IOException) { }
          catch (JsonException) { }
          catch (UnauthorizedAccessException) { }
          catch (KeyNotFoundException) { }
        if (!agent.HasExited) {
            // Durable job runners are independent children and retain their own
            // Job Object handles. Kill only the facade process if it cannot stop.
            agent.Kill();
            agent.WaitForExit(5000);
        }
        agent.Dispose();
        agent = null;
    }

    protected override void ExitThreadCore()
    {
        heartbeat.Stop();
        Stop();
        icon.Visible = false;
        icon.Dispose();
        base.ExitThreadCore();
    }
}

internal static class Native
{
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    internal static bool IsTrustedService(Microsoft.Win32.SafeHandles.SafePipeHandle pipe)
    {
        if (!GetNamedPipeServerProcessId(pipe, out var pid) || !ProcessIdToSessionId(pid, out var session) || session != 0)
            return false;
        var process = OpenProcess(0x1000, false, pid);
        if (process == 0) return false;
        try {
            if (!OpenProcessToken(process, 0x0008, out var token)) return false;
            try {
                using var identity = new WindowsIdentity(token);
                return identity.User?.Value == "S-1-5-19";
            } finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
    }
}
