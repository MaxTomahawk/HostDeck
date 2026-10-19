using System.IO.Pipes;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace HostDeck.DesktopWorker;

internal static class EnrollmentVerifier
{
    internal static async Task<object> Verify(string metadataPath)
    {
        if (Native.IsElevated() || System.Diagnostics.Process.GetCurrentProcess().SessionId <= 0)
            throw new WorkerError("ELEVATED_OR_SYSTEM_VERIFIER");
        using var metadata = JsonDocument.Parse(await File.ReadAllTextAsync(metadataPath));
        var expected = metadata.RootElement;
        var deviceId = expected.GetProperty("DeviceId").GetString() ?? "";
        var generation = expected.GetProperty("Generation").GetInt32();
        var fingerprint = expected.GetProperty("Fingerprint").GetString() ?? "";
        var spki = expected.GetProperty("PublicKeySpkiBase64").GetString() ?? "";
        var publicKey = Convert.FromBase64String(spki);
        if (generation < 1 || fingerprint != Convert.ToHexString(SHA256.HashData(publicKey)).ToLowerInvariant())
            throw new WorkerError("ENROLLMENT_METADATA_INVALID");
        using var pipe = new NamedPipeClientStream(".", "HostDeck.Service", PipeDirection.InOut,
            PipeOptions.Asynchronous);
        await pipe.ConnectAsync(3000);
        if (!VerifierNative.IsTrustedHostDeckService(pipe.SafePipeHandle, metadataPath)) throw new WorkerError("BROKER_IDENTITY_INVALID");
        using var reader = new StreamReader(pipe, leaveOpen: true);
        using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };
        var challenge = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { operation = "identity_challenge", challenge_base64 = challenge }));
        var line = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        if (line is null || line.Length > 4096) throw new WorkerError("BROKER_PROOF_INVALID");
        using var response = JsonDocument.Parse(line);
        var proof = response.RootElement;
        if (proof.GetProperty("device_id").GetString() != deviceId || proof.GetProperty("generation").GetInt32() != generation
            || proof.GetProperty("fingerprint").GetString() != fingerprint
            || proof.GetProperty("public_key_spki_base64").GetString() != spki)
            throw new WorkerError("BROKER_PROOF_INVALID");
        using var verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(publicKey, out _);
        var message = Encoding.UTF8.GetBytes($"HostDeck/device-proof/v1\n{deviceId}\n{generation}\n{challenge}");
        if (!verifier.VerifyData(message, Convert.FromBase64String(proof.GetProperty("signature_base64").GetString() ?? ""), HashAlgorithmName.SHA256))
            throw new WorkerError("BROKER_PROOF_INVALID");
        return new { verified = true, device_id = deviceId, generation, fingerprint,
            sid = WindowsIdentity.GetCurrent().User?.Value,
            session_id = System.Diagnostics.Process.GetCurrentProcess().SessionId,
            logon_id = Native.LogonId() };
    }
}

internal static class VerifierNative
{
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint OpenService(nint manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(nint service, int infoLevel, out ServiceStatusProcess status, int bufferSize, out int needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig(nint service, nint buffer, int bufferSize, out int needed);
    [DllImport("advapi32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(nint handle);
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode, ServiceSpecificExitCode;
        public uint CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceConfig
    {
        public uint ServiceType, StartType, ErrorControl;
        public nint BinaryPathName, LoadOrderGroup;
        public uint TagId;
        public nint Dependencies, ServiceStartName, DisplayName;
    }
    internal static bool IsTrustedHostDeckService(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, string metadataPath)
    {
        if (!GetNamedPipeServerProcessId(pipe, out var pid) || !ProcessIdToSessionId(pid, out var session) || session != 0)
            return false;
        var metadata = Path.GetFullPath(metadataPath);
        var enrollment = Path.GetDirectoryName(metadata);
        if (enrollment is null || !Path.GetFileName(metadata).Equals("device.json", StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(enrollment).Equals("enrollment", StringComparison.OrdinalIgnoreCase)) return false;
        var root = Directory.GetParent(enrollment)?.FullName;
        if (root is null) return false;
        var serviceExe = Path.Combine(root, "current", "service", "HostDeck.Lifecycle.exe");
        var serviceConfig = Path.Combine(root, "service-config.json");
        var expectedCommand = $"\"{serviceExe}\" --service \"{serviceConfig}\"";
        var manager = OpenSCManager(null, null, 0x0001); // SC_MANAGER_CONNECT
        if (manager == 0) return false;
        try {
            var service = OpenService(manager, "HostDeck", 0x0005); // QUERY_CONFIG | QUERY_STATUS
            if (service == 0) return false;
            try {
                if (!QueryServiceStatusEx(service, 0, out var status, Marshal.SizeOf<ServiceStatusProcess>(), out _)
                    || status.CurrentState != 4 || status.ProcessId != pid) return false;
                _ = QueryServiceConfig(service, 0, 0, out var needed);
                if (needed <= 0 || needed > 32768) return false;
                var buffer = Marshal.AllocHGlobal(needed);
                try {
                    if (!QueryServiceConfig(service, buffer, needed, out _)) return false;
                    var config = Marshal.PtrToStructure<ServiceConfig>(buffer);
                    var command = Marshal.PtrToStringUni(config.BinaryPathName);
                    var startName = Marshal.PtrToStringUni(config.ServiceStartName);
                    if (!string.Equals(command, expectedCommand, StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(startName)) return false;
                    var accountSid = (SecurityIdentifier)new NTAccount(startName).Translate(typeof(SecurityIdentifier));
                    return accountSid.Value == "S-1-5-19";
                } finally { Marshal.FreeHGlobal(buffer); }
            } finally { CloseServiceHandle(service); }
        } catch (IdentityNotMappedException) { return false; }
        finally { CloseServiceHandle(manager); }
    }
}
