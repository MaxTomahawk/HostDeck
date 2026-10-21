using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;

namespace HostDeck.DesktopWorker;

internal static class JobStatus
{
    internal sealed record Marker(uint ProcessId, long CreationTimeUtcTicks, int SessionId, string Sid, long WrittenAtUnixMs);

    internal static void WriteMarker(string path, Marker marker)
    {
        if (!Path.IsPathFullyQualified(path)) throw new InvalidDataException("Marker path must be absolute.");
        var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temp, JsonSerializer.Serialize(marker));
        File.Move(temp, path, false);
    }

    internal static string Check(string markerPath)
    {
        Marker? marker;
        try {
            if (!Path.IsPathFullyQualified(markerPath)) return "unknown";
            marker = JsonSerializer.Deserialize<Marker>(File.ReadAllText(markerPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        } catch (FileNotFoundException) { return "unknown"; }
        catch (DirectoryNotFoundException) { return "unknown"; }
        catch (IOException) { return "unknown"; }
        catch (JsonException) { return "unknown"; }
        if (marker is null || marker.ProcessId == 0 || marker.SessionId <= 0 || marker.CreationTimeUtcTicks <= 0 || string.IsNullOrWhiteSpace(marker.Sid)) return "unknown";
        try {
            using var process = Process.GetProcessById(checked((int)marker.ProcessId));
            if (process.HasExited) return "absent";
            if (process.StartTime.ToUniversalTime().Ticks != marker.CreationTimeUtcTicks || process.SessionId != marker.SessionId) return "absent";
            if (!OpenProcessToken(process.Handle, 0x0008, out var token)) return "unknown";
            try { using var identity = new WindowsIdentity(token); return identity.User?.Value == marker.Sid ? "alive" : "absent"; }
            finally { CloseHandle(token); }
        } catch (ArgumentException) { return "absent"; }
        catch (InvalidOperationException) { return "absent"; }
        catch (System.ComponentModel.Win32Exception) { return "unknown"; }
        catch (OverflowException) { return "unknown"; }
    }

    internal static void Remove(string path) { try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { } }

    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);
}
