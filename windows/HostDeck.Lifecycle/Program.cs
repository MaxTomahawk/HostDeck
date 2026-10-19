using System.ServiceProcess;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text;

namespace HostDeck.Lifecycle;

// This narrow service owns no user command or desktop adapter. The per-user
// agent starts separately under the enrolled user token.
internal sealed class LifecycleService : ServiceBase
{
    private readonly string enrolledSid;
    private readonly string enrollmentDirectory;
    private readonly string deviceId;
    private readonly CancellationTokenSource stop = new();
    private Task? server;
    private NamedPipeServerStream? pipe;
    private PipeSecurity? pipeAcl;
    private Enrollment? enrollment;
    private DateTimeOffset lastAgentSeen;
    private int lastSession;
    private string? lastLogon;

    public LifecycleService(string configPath)
    {
        using var json = JsonDocument.Parse(File.ReadAllText(configPath));
        enrolledSid = json.RootElement.GetProperty("enrolled_user_sid").GetString()
            ?? throw new InvalidDataException("Missing enrolled user SID.");
        enrollmentDirectory = json.RootElement.GetProperty("enrollment_directory").GetString()
            ?? throw new InvalidDataException("Missing enrollment directory.");
        deviceId = json.RootElement.GetProperty("device_id").GetString()
            ?? throw new InvalidDataException("Missing device ID.");
        _ = new SecurityIdentifier(enrolledSid);
        ServiceName = "HostDeck";
        CanStop = true;
        AutoLog = false;
    }

    protected override void OnStart(string[] args)
    {
        enrollment = Enrollment.OpenOrCreate(enrollmentDirectory, deviceId);
        var acl = new PipeSecurity();
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(enrolledSid),
            PipeAccessRights.ReadWrite, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        pipeAcl = acl;
        pipe = Native.CreateProtectedPipe(acl);
        server = Task.Run(Serve);
    }

    private async Task Serve()
    {
        while (!stop.IsCancellationRequested) {
            try {
                var current = pipe ?? Native.CreateProtectedPipe(pipeAcl ?? throw new IOException("Pipe ACL unavailable."));
                pipe = current;
                await current.WaitForConnectionAsync(stop.Token);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(3));
                using var reader = new StreamReader(current, leaveOpen: true);
                using var writer = new StreamWriter(current, leaveOpen: true) { AutoFlush = true };
                var line = await ReadLineBounded(reader, timeout.Token);
                if (line is null) continue;
                var sid = "";
                var logon = "";
                var session = 0;
                current.RunAsClient(() => {
                    using var identity = WindowsIdentity.GetCurrent(true);
                    sid = identity?.User?.Value ?? "";
                    logon = identity is null ? "" : Native.LogonId(identity.Token);
                    session = identity is null ? 0 : Native.SessionId(identity.Token);
                });
                if (!Native.GetNamedPipeClientProcessId(current.SafePipeHandle, out var pid)
                    || pid == 0 || session <= 0
                    || sid != enrolledSid || logon == "") continue;
                using var request = JsonDocument.Parse(line);
                var operation = request.RootElement.TryGetProperty("operation", out var requested)
                    ? requested.GetString() : null;
                if (operation == "identity_challenge") {
                    var challenge = request.RootElement.GetProperty("challenge_base64").GetString() ?? "";
                    await writer.WriteLineAsync(JsonSerializer.Serialize(enrollment!.SignChallenge(challenge)));
                    continue;
                }
                if (operation == "register") {
                    if (lastLogon is not null && (lastLogon != logon || lastSession != session)
                        && lastAgentSeen > DateTimeOffset.UtcNow.AddMinutes(-1)) continue;
                    lastAgentSeen = DateTimeOffset.UtcNow;
                    lastSession = session;
                    lastLogon = logon;
                }
                if (lastLogon is not null && (lastLogon != logon || lastSession != session)) continue;
                await writer.WriteLineAsync(JsonSerializer.Serialize(new {
                    healthy = true, agent_online = lastAgentSeen > DateTimeOffset.UtcNow.AddMinutes(-1),
                    agent_seen_at = lastAgentSeen, agent_session_id = lastSession,
                    caller_session_id = session
                }));
            } catch (OperationCanceledException) { if (stop.IsCancellationRequested) break; }
            catch (IOException) { }
            catch (JsonException) { }
            catch (Exception) { }
            finally {
                // A pipe that observed EOF may report IsConnected=false while
                // its single server instance still occupies the name. Dispose
                // it unconditionally and create a fresh first instance.
                pipe?.Dispose();
                pipe = null;
            }
        }
    }

    private static async Task<string?> ReadLineBounded(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[1];
        var line = new System.Text.StringBuilder();
        while (line.Length <= 256) {
            if (await reader.ReadAsync(buffer, cancellation) == 0) return null;
            if (buffer[0] == '\n') return line.ToString().TrimEnd('\r');
            line.Append(buffer[0]);
        }
        return null;
    }

    protected override void OnStop()
    {
        stop.Cancel();
        pipe?.Dispose();
        enrollment?.Dispose();
        try { server?.Wait(TimeSpan.FromSeconds(3)); } catch (AggregateException) { }
    }

    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--version") {
            Console.WriteLine(typeof(LifecycleService).Assembly.GetName().Version);
            return;
        }
        if (args.Length == 1 && args[0] == "--selftest-enrollment") {
            Enrollment.SelfTest();
            Console.WriteLine("enrollment self-test passed");
            return;
        }
        if (args.Length != 2 || args[0] != "--service") return;
        ServiceBase.Run(new LifecycleService(args[1]));
    }
}

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes {
        internal int Length; internal nint SecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] private struct TokenStatistics {
        public Luid TokenId; public Luid AuthenticationId; public long Expiration;
        public int TokenType; public int ImpersonationLevel; public uint DynamicCharged;
        public uint DynamicAvailable; public uint GroupCount; public uint PrivilegeCount; public Luid ModifiedId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern Microsoft.Win32.SafeHandles.SafePipeHandle CreateNamedPipe(string name, uint openMode,
        uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(nint token, int infoClass, nint buffer, int length, out int needed);
    internal static NamedPipeServerStream CreateProtectedPipe(PipeSecurity security)
    {
        var bytes = security.GetSecurityDescriptorBinaryForm();
        var descriptor = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, descriptor, bytes.Length);
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), SecurityDescriptor = descriptor };
            // FIRST_PIPE_INSTANCE blocks pre-creation; REJECT_REMOTE_CLIENTS
            // stops network named-pipe transport even if the DACL is valid.
            var handle = CreateNamedPipe(@"\\.\pipe\HostDeck.Service", 0x00000003 | 0x00080000 | 0x40000000,
                0x00000008, 1, 4096, 4096, 0, ref attributes);
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        } finally { Marshal.FreeHGlobal(descriptor); }
    }
    internal static string LogonId(nint token)
    {
        var size = Marshal.SizeOf<TokenStatistics>();
        var buffer = Marshal.AllocHGlobal(size);
        try {
            if (!GetTokenInformation(token, 10, buffer, size, out _)) return "";
            var value = Marshal.PtrToStructure<TokenStatistics>(buffer);
            return $"{value.AuthenticationId.High:x8}{value.AuthenticationId.Low:x8}";
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static int SessionId(nint token)
    {
        var buffer = Marshal.AllocHGlobal(sizeof(int));
        try {
            return GetTokenInformation(token, 12, buffer, sizeof(int), out _) ? Marshal.ReadInt32(buffer) : 0;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle handle, out uint processId);
}
