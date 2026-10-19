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
        if (!VerifierNative.IsLocalService(pipe.SafePipeHandle)) throw new WorkerError("BROKER_IDENTITY_INVALID");
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
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    internal static bool IsLocalService(Microsoft.Win32.SafeHandles.SafePipeHandle pipe)
    {
        if (!GetNamedPipeServerProcessId(pipe, out var pid) || !ProcessIdToSessionId(pid, out var session) || session != 0)
            return false;
        var process = OpenProcess(0x1000, false, pid);
        if (process == 0) return false;
        try {
            if (!OpenProcessToken(process, 0x0008, out var token)) return false;
            try { using var identity = new WindowsIdentity(token); return identity.User?.Value == "S-1-5-19"; }
            finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
    }
}
