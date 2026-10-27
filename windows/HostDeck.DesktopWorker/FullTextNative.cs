using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HostDeck.DesktopWorker;

/// <summary>
/// Internal, read-only, persistent local stdio companion for the fulltext author.
/// This is NOT an MCP operation or a caller authorization/selection mechanism.
/// One process accepts bounded newline JSON batches; no file contents are read.
/// </summary>
internal static class FullTextNative
{
    private const int MaxInputChars = 65536, MaxBatch = 64;
    private const int MaxPathChars = 4096, MaxTotalPathChars = 32768;
    private const int MaxBatchMs = 2000;
    private const uint InvalidAttributes = 0xffffffff;
    private const uint Hidden = 0x0002, SystemAttribute = 0x0004, Directory = 0x0010, Reparse = 0x0400;

    [DllImport("kernel32.dll", EntryPoint = "GetFileAttributesW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string fileName);

    [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveTypeW(string root);

    internal static async Task Run()
    {
        // Never use this helper as an elevation or SYSTEM broker. The caller
        // independently authorizes owner, device, roots and tool scopes.
        if (Native.IsElevated() || System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem) {
            Console.Out.WriteLine(JsonSerializer.Serialize(new { error = new { code = "FULLTEXT_NATIVE_PRIVILEGED_WORKER_DENIED" } }));
            return;
        }
        while (true)
        {
            string? line;
            try { line = ReadBoundedLine(); }
            catch (Exception) {
                Console.Out.WriteLine(JsonSerializer.Serialize(new { error = new { code = "FULLTEXT_NATIVE_INPUT_LIMIT" } }));
                return; // discard malformed stream, no resynchronisation guess
            }
            if (line is null) return;
            string? id = null;
            object response;
            try
            {
                using var document = JsonDocument.Parse(line);
                var request = document.RootElement;
                if (request.ValueKind != JsonValueKind.Object) throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
                id = request.GetProperty("id").GetString();
                if (id is null || !Regex.IsMatch(id, @"^[A-Za-z0-9_-]{1,64}$",
                      RegexOptions.CultureInvariant)) throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
                var operation = request.GetProperty("operation").GetString();
                var args = request.GetProperty("args");
                if (args.ValueKind != JsonValueKind.Object) throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
                object result = operation switch
                {
                    "attributes_batch" => Attributes(args),
                    "directory_page" => DirectoryPage(args),
                    "effective_acl" => FullTextProtectedAcl.Qualify(RequiredPath(args)),
                    "owner_boundary" => FullTextProtectedAcl.QualifyBoundary(
                        RequiredPath(args, "protectedDirectory"),
                        RequiredPath(args, "selectionFile"),
                        RequiredPath(args, "approvalFile"),
                        RequiredPath(args, "indexDirectory")),
                    "identity" => Identity(),
                    _ => throw new WorkerError("FULLTEXT_NATIVE_UNKNOWN_OPERATION")
                };
                response = new { id, result };
            }
            catch (Exception error)
            {
                var code = error is WorkerError known &&
                    known.Message.StartsWith("FULLTEXT_NATIVE_", StringComparison.Ordinal)
                    ? known.Message : "FULLTEXT_NATIVE_UNAVAILABLE";
                response = new { id, error = new { code } };
            }
            Console.Out.WriteLine(JsonSerializer.Serialize(response));
            await Console.Out.FlushAsync();
        }
    }

    // Fully bounds memory even if a producer sends a missing newline.
    private static string? ReadBoundedLine()
    {
        var value = new StringBuilder();
        while (true)
        {
            int next = Console.In.Read();
            if (next < 0) return value.Length == 0 ? null : value.ToString();
            if (next == '\n') return value.ToString();
            if (value.Length == MaxInputChars) throw new WorkerError("FULLTEXT_NATIVE_INPUT_LIMIT");
            if (next != '\r') value.Append((char)next);
        }
    }

    internal static string RequiredPath(JsonElement args) => RequiredPath(args, "path");

    private static string RequiredPath(JsonElement args, string field)
    {
        if (!args.TryGetProperty(field, out var element) || element.ValueKind != JsonValueKind.String)
            throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
        return LocalPath(element.GetString());
    }

    private static object Identity()
    {
        var token = System.Security.Principal.WindowsIdentity.GetCurrent();
        // Private IPC only: the coordinator MUST compare this to its trusted
        // executor identity. This is a same-token check, not cryptographic
        // intended-application isolation or a public authorization claim.
        return new { sid = token.User?.Value, logon_id = Native.LogonId(),
            session_id = Process.GetCurrentProcess().SessionId,
            elevated = Native.IsElevated(), integrity = Native.Integrity() };
    }

    /// <summary>Only ordinary absolute local fixed-disk paths, not an authorizer.</summary>
    internal static string LocalPath(string? input)
    {
        if (string.IsNullOrWhiteSpace(input) || input.Length > MaxPathChars ||
            input.Contains('\0') || input.StartsWith(@"\\", StringComparison.Ordinal) ||
            input.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            !Regex.IsMatch(input, @"^[A-Za-z]:\\", RegexOptions.CultureInvariant) ||
            !Path.IsPathFullyQualified(input))
            throw new WorkerError("FULLTEXT_NATIVE_PATH_DENIED");
        // Reject path aliases, alternate data streams and volume remapping.
        var parts = input.Substring(3).Split('\\', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(x => x == "." || x == ".." || x.Contains(':') ||
            x.EndsWith('.') || x.EndsWith(' ')))
            throw new WorkerError("FULLTEXT_NATIVE_PATH_DENIED");
        var full = Path.GetFullPath(input);
        if (full.Length > MaxPathChars ||
            GetDriveTypeW(full.Substring(0, 3)) != 3 /* DRIVE_FIXED */)
            throw new WorkerError("FULLTEXT_NATIVE_PATH_DENIED");
        return full;
    }

    // Existing pinned, non-elevated native worker: bounded READ-ONLY directory
    // enumeration against the opened HANDLE, never a separate path walk.
    // FileIdBothDirectoryInfo is FILE_INFO_BY_HANDLE_CLASS 10; filename offset
    // is 104 bytes in the Windows FILE_ID_BOTH_DIR_INFO ABI on x64.
    private const uint ListDirectory = 0x0001, ShareAll = 0x0007;
    private const uint OpenExisting = 3, BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const int FileIdBothDirectoryInfo = 10, NameOffset = 104;
    private const int DirectoryBufferBytes = 32768, DirectoryMaxNames = 192;
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleInformation {
        public uint Attributes;
        public NativeFileTime Creation, Access, Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, FileIdHigh, FileIdLow;
    }
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateDirectoryHandle(string name,
        uint access, uint share, IntPtr security, uint disposition, uint flags,
        IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
        out ByHandleInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int informationClass, byte[] buffer, uint bufferLength);

    private static object DirectoryPage(JsonElement args)
    {
        var requested = RequiredPath(args);
        if (!args.TryGetProperty("expected_dev", out var deviceRaw) ||
            deviceRaw.ValueKind != JsonValueKind.String ||
            !ulong.TryParse(deviceRaw.GetString(), out var expectedDev) ||
            expectedDev == 0 ||
            !args.TryGetProperty("expected_ino", out var inodeRaw) ||
            inodeRaw.ValueKind != JsonValueKind.String ||
            !ulong.TryParse(inodeRaw.GetString(), out var expectedInode) ||
            expectedInode == 0 ||
            !args.TryGetProperty("offset", out var offsetRaw) ||
            !offsetRaw.TryGetInt32(out var offset) ||
            offset is < 0 or > 100000 ||
            !args.TryGetProperty("limit", out var limitRaw) ||
            !limitRaw.TryGetInt32(out var limit) ||
            limit is < 1 or > DirectoryMaxNames)
            throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");

        var stopwatch = Stopwatch.StartNew();
        using var handle = CreateDirectoryHandle(requested, ListDirectory,
            ShareAll, IntPtr.Zero, OpenExisting,
            BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info))
            throw new WorkerError("FULLTEXT_NATIVE_DIRECTORY_UNQUALIFIED");
        var actualInode = ((ulong)info.FileIdHigh << 32) | info.FileIdLow;
        if (actualInode != expectedInode ||
            (ulong)info.VolumeSerial != expectedDev ||
            (info.Attributes & Directory) == 0 ||
            (info.Attributes & (Hidden | SystemAttribute | Reparse)) != 0)
            throw new WorkerError("FULLTEXT_NATIVE_DIRECTORY_CHANGED");

        var names = new List<string>();
        var current = 0;
        var chars = 0;
        var more = false;
        var end = false;
        var buffer = new byte[DirectoryBufferBytes];
        while (!end && !more)
        {
            if (stopwatch.ElapsedMilliseconds >= MaxBatchMs)
                throw new WorkerError("FULLTEXT_NATIVE_BATCH_DEADLINE");
            if (!GetFileInformationByHandleEx(handle, FileIdBothDirectoryInfo,
                buffer, (uint)buffer.Length))
            {
                if (Marshal.GetLastWin32Error() == 18 /* ERROR_NO_MORE_FILES */) break;
                throw new WorkerError("FULLTEXT_NATIVE_DIRECTORY_UNQUALIFIED");
            }
            var at = 0;
            while (at < buffer.Length)
            {
                if (at + NameOffset > buffer.Length)
                    throw new WorkerError("FULLTEXT_NATIVE_PROTOCOL_INVALID");
                var next = BitConverter.ToUInt32(buffer, at);
                var length = BitConverter.ToUInt32(buffer, at + 60);
                if ((length & 1) != 0 || length > 32768 ||
                    (ulong)at + NameOffset + length > (ulong)buffer.Length)
                    throw new WorkerError("FULLTEXT_NATIVE_PROTOCOL_INVALID");
                var name = Encoding.Unicode.GetString(buffer, at + NameOffset, (int)length);
                if (name != "." && name != "..")
                {
                    if (name.Length is < 1 or > 255 ||
                        name.Contains('\0') || name.Contains('\\') ||
                        name.Contains('/') || name.Contains(':'))
                        throw new WorkerError("FULLTEXT_NATIVE_PROTOCOL_INVALID");
                    if (current++ >= offset)
                    {
                        if (names.Count >= limit || chars + name.Length > 12000)
                        {
                            more = true; break;
                        }
                        names.Add(name);
                        chars += name.Length;
                    }
                }
                if (next == 0) { end = false; break; }
                if (next < NameOffset || (ulong)at + next >= (ulong)buffer.Length)
                    throw new WorkerError("FULLTEXT_NATIVE_PROTOCOL_INVALID");
                at += checked((int)next);
            }
        }
        if (!GetFileInformationByHandle(handle, out var ending) ||
            ending.FileIdHigh != info.FileIdHigh ||
            ending.FileIdLow != info.FileIdLow ||
            ending.VolumeSerial != info.VolumeSerial)
            throw new WorkerError("FULLTEXT_NATIVE_DIRECTORY_CHANGED");
        return new { names, more, next_offset = offset + names.Count };
    }

    private static object Attributes(JsonElement args)
    {
        if (!args.TryGetProperty("paths", out var raw) || raw.ValueKind != JsonValueKind.Array ||
            raw.GetArrayLength() is < 1 or > MaxBatch)
            throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
        var paths = new List<string>(raw.GetArrayLength());
        var total = 0;
        foreach (var item in raw.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
                throw new WorkerError("FULLTEXT_NATIVE_INVALID_ARGUMENTS");
            var input = item.GetString() ?? "";
            total = checked(total + input.Length);
            if (total > MaxTotalPathChars) throw new WorkerError("FULLTEXT_NATIVE_BATCH_LIMIT");
            paths.Add(LocalPath(input));
        }
        var stopwatch = Stopwatch.StartNew();
        var records = new List<object>(paths.Count);
        for (int i = 0; i < paths.Count; i++)
        {
            if (stopwatch.ElapsedMilliseconds >= MaxBatchMs)
                throw new WorkerError("FULLTEXT_NATIVE_BATCH_DEADLINE");
            records.Add(AttributeRecord(paths[i], i));
        }
        // No paths, directory listing, body bytes or caller-selected privilege
        // fields are returned. Indexes preserve original request ordering.
        return new { count = records.Count, items = records };
    }

    private static object AttributeRecord(string absolute, int index)
    {
        var parent = Path.GetPathRoot(absolute)!;
        uint latest = InvalidAttributes;
        bool anyHidden = false, anySystem = false;
        var components = absolute.Substring(parent.Length)
            .Split('\\', StringSplitOptions.RemoveEmptyEntries);
        var sequence = new List<string> { parent };
        foreach (var component in components)
        {
            parent = Path.Combine(parent, component);
            sequence.Add(parent);
        }
        foreach (var component in sequence)
        {
            var attributes = GetFileAttributesW(component);
            if (attributes == InvalidAttributes)
                return new { index, status = "unavailable", hidden = (bool?)null,
                    system = (bool?)null, reparse = (bool?)null,
                    hidden_component = (bool?)null, system_component = (bool?)null,
                    directory = (bool?)null };
            if ((attributes & Reparse) != 0)
                return new { index, status = "reparse_component", hidden = (bool?)null,
                    system = (bool?)null, reparse = (bool?)true,
                    hidden_component = (bool?)null, system_component = (bool?)null,
                    directory = (bool?)null };
            anyHidden |= (attributes & Hidden) != 0;
            anySystem |= (attributes & SystemAttribute) != 0;
            latest = attributes;
        }
        return new { index, status = "ok", hidden = (bool?)((latest & Hidden) != 0),
            system = (bool?)((latest & SystemAttribute) != 0), reparse = (bool?)false,
            hidden_component = (bool?)anyHidden, system_component = (bool?)anySystem,
            directory = (bool?)((latest & Directory) != 0) };
    }
}
