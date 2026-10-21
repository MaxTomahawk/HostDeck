using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HostDeck.Lifecycle;

internal sealed class Enrollment : IDisposable
{
    private readonly ECDsaCng signer;
    private readonly Metadata metadata;

    private Enrollment(ECDsaCng signer, Metadata metadata)
    {
        this.signer = signer;
        this.metadata = metadata;
    }

    internal static Enrollment OpenOrCreate(string directory, string expectedDeviceId)
    {
        var path = Path.Combine(directory, "device.json");
        if (File.Exists(path)) {
            var existing = JsonSerializer.Deserialize<Metadata>(File.ReadAllText(path))
                ?? throw new InvalidDataException("Enrollment metadata invalid.");
            using var key = CngKey.Open(existing.KeyName, CngProvider.MicrosoftSoftwareKeyStorageProvider);
            var signer = new ECDsaCng(key);
            var publicKey = signer.ExportSubjectPublicKeyInfo();
            var fingerprint = Convert.ToHexString(SHA256.HashData(publicKey)).ToLowerInvariant();
            if (existing.DeviceId != expectedDeviceId || existing.Generation < 1 || existing.Fingerprint != fingerprint
                || existing.PublicKeySpkiBase64 != Convert.ToBase64String(publicKey))
                throw new InvalidDataException("Enrollment key mismatch.");
            return new Enrollment(signer, existing);
        }
        // The installer grants only LocalService write access here. Never
        // recreate an identity if metadata exists but the key is missing.
        var keyName = "HostDeck.Device." + Guid.NewGuid().ToString("N");
        var parameters = new CngKeyCreationParameters {
            Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
            ExportPolicy = CngExportPolicies.None,
            KeyUsage = CngKeyUsages.Signing,
        };
        using var created = CngKey.Create(CngAlgorithm.ECDsaP256, keyName, parameters);
        var freshSigner = new ECDsaCng(created);
        var spki = freshSigner.ExportSubjectPublicKeyInfo();
        var fresh = new Metadata(
            DeviceId: expectedDeviceId,
            Generation: 1, KeyName: keyName,
            Fingerprint: Convert.ToHexString(SHA256.HashData(spki)).ToLowerInvariant(),
            PublicKeySpkiBase64: Convert.ToBase64String(spki));
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, JsonSerializer.Serialize(fresh));
        File.Move(temporary, path, false);
        return new Enrollment(freshSigner, fresh);
    }

    internal object SignChallenge(string challengeBase64)
    {
        byte[] challenge;
        try { challenge = Convert.FromBase64String(challengeBase64); }
        catch (FormatException) { throw new InvalidDataException("Invalid challenge."); }
        if (challenge.Length != 32) throw new InvalidDataException("Challenge must be 32 bytes.");
        var message = Message(metadata.DeviceId, metadata.Generation, challengeBase64);
        return new {
            device_id = metadata.DeviceId, generation = metadata.Generation,
            public_key_spki_base64 = metadata.PublicKeySpkiBase64,
            fingerprint = metadata.Fingerprint,
            signature_base64 = Convert.ToBase64String(signer.SignData(message, HashAlgorithmName.SHA256))
        };
    }

    internal static byte[] Message(string deviceId, int generation, string challengeBase64) =>
        Encoding.UTF8.GetBytes($"HostDeck/device-proof/v1\n{deviceId}\n{generation}\n{challengeBase64}");

    internal static void SelfTest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "hostdeck-enrollment-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string? keyName = null;
        try {
            var device = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var challenge = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
            using (var created = OpenOrCreate(directory, device)) {
                using var proof = JsonDocument.Parse(JsonSerializer.Serialize(created.SignChallenge(challenge)));
                var p = proof.RootElement;
                var publicKey = Convert.FromBase64String(p.GetProperty("public_key_spki_base64").GetString()!);
                using var verifier = ECDsa.Create();
                verifier.ImportSubjectPublicKeyInfo(publicKey, out _);
                if (!verifier.VerifyData(Message(device, 1, challenge),
                    Convert.FromBase64String(p.GetProperty("signature_base64").GetString()!), HashAlgorithmName.SHA256))
                    throw new InvalidDataException("Device proof failed.");
            }
            var metadata = JsonSerializer.Deserialize<Metadata>(File.ReadAllText(Path.Combine(directory, "device.json")))!;
            keyName = metadata.KeyName;
            using var reopened = OpenOrCreate(directory, device);
            try { using var wrong = OpenOrCreate(directory, "wrong-device"); throw new InvalidDataException("Mismatched device accepted."); }
            catch (InvalidDataException ex) when (ex.Message == "Enrollment key mismatch.") { }
        } finally {
            if (keyName is not null) { using var key = CngKey.Open(keyName, CngProvider.MicrosoftSoftwareKeyStorageProvider); key.Delete(); }
            Directory.Delete(directory, true);
        }
    }

    public void Dispose() => signer.Dispose();

    internal sealed record Metadata(string DeviceId, int Generation, string KeyName,
        string Fingerprint, string PublicKeySpkiBase64);
}
