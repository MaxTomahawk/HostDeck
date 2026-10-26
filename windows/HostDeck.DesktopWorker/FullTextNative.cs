using System.Diagnostics;
using System.Runtime.InteropServices;
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
    private const uint Hidden = 0x0002, System = 0x0004, Directory = 0x0010, Reparse = 0x0400;

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
        if (parts.Any(x => x is "." or ".." || x.Contains(':') ||
            x.EndsWith('.') || x.EndsWith(' ')))
            throw new WorkerError("FULLTEXT_NATIVE_PATH_DENIED");
        var full = Path.GetFullPath(input);
        if (full.Length > MaxPathChars ||
            GetDriveTypeW(full.Substring(0, 3)) != 3 /* DRIVE_FIXED */)
            throw new WorkerError("FULLTEXT_NATIVE_PATH_DENIED");
        return full;
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
            anySystem |= (attributes & System) != 0;
            latest = attributes;
        }
        return new { index, status = "ok", hidden = (bool?)((latest & Hidden) != 0),
            system = (bool?)((latest & System) != 0), reparse = (bool?)false,
            hidden_component = (bool?)anyHidden, system_component = (bool?)anySystem,
            directory = (bool?)((latest & Directory) != 0) };
    }
}
