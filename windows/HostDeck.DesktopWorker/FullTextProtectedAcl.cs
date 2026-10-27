using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace HostDeck.DesktopWorker;

/// <summary>
/// A read-only, fail-closed Windows filesystem ACL qualification for the
/// *current process token*. Does not approve a user/ChatGPT request, assert
/// same-SID application exclusivity, rewrite ACLs or perform any file edit.
/// Positive results are only momentary physical filesystem observations.
/// </summary>
internal static class FullTextProtectedAcl
{

    private const uint TokenQuery = 0x0008, TokenDuplicate = 0x0002, TokenImpersonate = 0x0004;
    private const uint ReadControl = 0x00020000, ReadAttributes = 0x0080;
    private const uint FileShareReadWriteDelete = 0x0007, OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
    private const uint OwnerSecurity = 0x00000001, DaclSecurity = 0x00000004;
    private const uint MaximumAllowed = 0x02000000;
    private const uint Delete = 0x00010000, WriteDac = 0x00040000, WriteOwner = 0x00080000;
    // File write data/add child, append data/add subdir, EA, delete_child,
    // attributes, standard rights and generic write/all.
    private const uint Dangerous = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 |
        0x00000100 | Delete | WriteDac | WriteOwner | 0x40000000 | 0x10000000;
    private const uint GenericRead = 0x00120089, GenericWrite = 0x00120116;
    private const uint GenericExecute = 0x001200a0, GenericAll = 0x001f01ff;
    private static readonly HashSet<string> TrustedSids = new(StringComparer.OrdinalIgnoreCase) {
        "S-1-5-18",       // LocalSystem
        "S-1-5-32-544",   // Builtin Administrators
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" // TrustedInstaller
    };
    private static readonly HashSet<string> DangerousPrivileges = new(StringComparer.OrdinalIgnoreCase) {
        "SeTakeOwnershipPrivilege", "SeRestorePrivilege", "SeBackupPrivilege",
        "SeSecurityPrivilege", "SeManageVolumePrivilege", "SeDebugPrivilege",
        "SeRelabelPrivilege", "SeImpersonatePrivilege", "SeCreateSymbolicLinkPrivilege"
    };

    internal static object Qualify(string path)
    {
        var inspected = 0;
        string reason;
        try
        {
            if (Native.IsElevated() || WindowsIdentity.GetCurrent().IsSystem ||
                Process.GetCurrentProcess().SessionId <= 0 ||
                Native.Integrity() != "medium")
                return Refuse("NOT_ORDINARY_INTERACTIVE_TOKEN", inspected);
            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenQuery | TokenDuplicate,
                out var token))
                return Refuse("TOKEN_UNAVAILABLE", inspected);
            try
            {
                if (!SafeTokenPrivileges(token)) return Refuse("TOKEN_PRIVILEGE_UNQUALIFIED", inspected);
                if (!DuplicateTokenEx(token, TokenQuery | TokenImpersonate, 0,
                    2 /* SecurityImpersonation */, 2 /* TokenImpersonation */, out var impersonation))
                    return Refuse("TOKEN_UNAVAILABLE", inspected);
                try
                {
                    var root = Path.GetPathRoot(path);
                    if (root is null) return Refuse("PATH_UNQUALIFIED", inspected);
                    var elements = new List<string> { root };
                    var cursor = root;
                    foreach (var segment in path.Substring(root.Length).Split('\\',
                        StringSplitOptions.RemoveEmptyEntries))
                    {
                        cursor = Path.Combine(cursor, segment);
                        elements.Add(cursor);
                        if (elements.Count > 40) return Refuse("PATH_DEPTH_LIMIT", inspected);
                    }
                    if (elements.Count < 2) return Refuse("PATH_UNQUALIFIED", inspected);
                    for (var i = 0; i < elements.Count; i++)
                    {
                        var last = i == elements.Count - 1;
                        reason = QualifyObject(elements[i], last, impersonation);
                        if (reason != "OK") return Refuse(reason, inspected);
                        inspected++;
                    }
                    return new { verified = true, status = "verified", code = "FULLTEXT_NATIVE_ACL_VERIFIED",
                        token_write_denied = true, trusted_owner_and_writers = true,
                        components_checked = inspected, scope = "physical_filesystem_snapshot_only" };
                }
                finally { CloseHandle(impersonation); }
            }
            finally { CloseHandle(token); }
        }
        catch (Exception)
        {
            // No file path, user SID, ACL or privilege details escape the worker.
            return Refuse("ACL_INSPECTION_FAILED", inspected);
        }
    }

    private static object Refuse(string reason, int inspected)
        => new { verified = false, status = "unqualified", code = "FULLTEXT_NATIVE_ACL_UNQUALIFIED",
            reason, components_checked = inspected, scope = "physical_filesystem_snapshot_only" };

    private static string QualifyObject(string name, bool last, nint token)
    {
        const uint desired = ReadAttributes | ReadControl;
        using var handle = CreateFileW(name, desired, FileShareReadWriteDelete, 0,
            OpenExisting, BackupSemantics | OpenReparsePoint, 0);
        if (handle.IsInvalid) return "OBJECT_METADATA_DENIED";
        if (!GetFileInformationByHandle(handle, out var info)) return "OBJECT_METADATA_DENIED";
        // A path traversing a junction or symlink cannot establish a protected
        // file boundary; multiple hardlinks would bypass this path's ACL.
        if ((info.FileAttributes & 0x400) != 0) return "REPARSE_COMPONENT";
        if (!last && (info.FileAttributes & 0x10) == 0) return "ANCESTOR_NOT_DIRECTORY";
        if (last && (info.FileAttributes & 0x10) == 0 && info.NumberOfLinks != 1)
            return "TARGET_HARDLINKED";
        var code = GetSecurityInfo(handle, 1 /* SE_FILE_OBJECT */, OwnerSecurity | DaclSecurity,
            out var owner, out _, out var dacl, out _, out var sd);
        if (code != 0 || sd == 0) return "SECURITY_DESCRIPTOR_DENIED";
        try
        {
            if (owner == 0 || !IsValidSid(owner) || !TrustedSid(owner))
                return "OWNER_NOT_TRUSTED";
            if (dacl == 0 || !TrustedWriters(dacl))
                return "DACL_WRITER_UNQUALIFIED";
            if (!TokenCannotWrite(sd, token))
                return "EFFECTIVE_WRITE_POSSIBLE";
            return "OK";
        }
        finally { LocalFree(sd); }
    }

    private static bool TrustedSid(nint sid)
    {
        if (!IsValidSid(sid)) return false;
        return TrustedSids.Contains(new SecurityIdentifier(sid).Value);
    }

    private static bool TrustedWriters(nint dacl)
    {
        // ACL header: revision(1), flags(1), size(2), aceCount(2).
        var length = (ushort)Marshal.ReadInt16(dacl, 2);
        var count = (ushort)Marshal.ReadInt16(dacl, 4);
        if (length < 8 || count > 2048) return false;
        for (uint i = 0; i < count; i++)
        {
            if (!GetAce(dacl, i, out var ace) || ace == 0) return false;
            byte type = Marshal.ReadByte(ace, 0);
            ushort size = (ushort)Marshal.ReadInt16(ace, 2);
            if (size < 16 || type is not (0 or 1)) {
                // Object, callback, conditional and unknown ACE forms require
                // a separate semantics review. Never assume they're harmless.
                return false;
            }
            if (type == 0 /* ACCESS_ALLOWED_ACE_TYPE */)
            {
                uint rights = unchecked((uint)Marshal.ReadInt32(ace, 4));
                if ((rights & Dangerous) != 0 && !TrustedSid(ace + 8))
                    return false;
            }
        }
        return true;
    }

    private static bool TokenCannotWrite(nint securityDescriptor, nint impersonation)
    {
        var mapping = new GenericMapping { Read = GenericRead, Write = GenericWrite,
            Execute = GenericExecute, All = GenericAll };
        uint privilegeLength = 4096;
        nint privilegeSet = Marshal.AllocHGlobal((int)privilegeLength);
        try
        {
            bool ok = AccessCheck(securityDescriptor, impersonation, MaximumAllowed,
                ref mapping, privilegeSet, ref privilegeLength,
                out var granted, out var accessible);
            // Invalid or unknowable effective access fails closed.
            return ok && accessible && (granted & Dangerous) == 0;
        }
        finally { Marshal.FreeHGlobal(privilegeSet); }
    }

    /// <summary>
    /// A single read-only physical qualification for the exact PR21 callback
    /// tuple: protectedDirectory, selectionFile, approvalFile, indexDirectory.
    /// This does not create or approve the protected records.
    /// </summary>
    internal static object QualifyBoundary(string protectedDirectory, string selection,
        string approval, string indexDirectory)
    {
        static bool Equal(string a, string b) =>
            string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        static bool ContainsPath(string ancestor, string child)
        {
            var a = Path.TrimEndingDirectorySeparator(Path.GetFullPath(ancestor));
            var b = Path.GetFullPath(child);
            return b.StartsWith(a + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || Equal(a, b);
        }
        if (Equal(selection, approval) ||
            !Equal(Path.GetDirectoryName(selection) ?? "", protectedDirectory) ||
            !Equal(Path.GetDirectoryName(approval) ?? "", protectedDirectory) ||
            ContainsPath(protectedDirectory, indexDirectory) ||
            ContainsPath(indexDirectory, protectedDirectory)) {
            return new { verified = false, status = "unqualified",
                code = "FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED",
                reason = "PROTECTED_INDEX_OVERLAP_OR_SCOPE_INVALID",
                scope = "physical_filesystem_snapshot_only" };
        }
        // Do not collapse the three checks: their physical security
        // descriptors may differ, even within the same parent directory.
        var directory = IsVerified(Qualify(protectedDirectory));
        var file1 = directory && IsVerified(Qualify(selection));
        var file2 = file1 && IsVerified(Qualify(approval));
        if (!file2) return new { verified = false, status = "unqualified",
            code = "FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED",
            reason = "PROTECTED_SOURCE_NOT_QUALIFIED",
            scope = "physical_filesystem_snapshot_only" };
        if (!CanWriteIndexDirectory(indexDirectory)) return new { verified = false,
            status = "unqualified", code = "FULLTEXT_NATIVE_BOUNDARY_UNQUALIFIED",
            reason = "SEPARATE_INDEX_NOT_WRITABLE_BY_WORKER",
            scope = "physical_filesystem_snapshot_only" };
        return new { verified = true, status = "verified",
            code = "FULLTEXT_NATIVE_BOUNDARY_VERIFIED",
            protected_sources = 3, writable_index_separate = true,
            scope = "physical_filesystem_snapshot_only" };
    }

    private static bool IsVerified(object value) =>
        value.GetType().GetProperty("verified")?.GetValue(value) is true;

    private static bool CanWriteIndexDirectory(string directory)
    {
        if (Native.IsElevated() || WindowsIdentity.GetCurrent().IsSystem ||
            Process.GetCurrentProcess().SessionId <= 0 || Native.Integrity() != "medium")
            return false;
        if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenQuery | TokenDuplicate, out var token))
            return false;
        try
        {
            if (!SafeTokenPrivileges(token) ||
                !DuplicateTokenEx(token, TokenQuery | TokenImpersonate, 0, 2, 2,
                    out var impersonation)) return false;
            try
            {
                var root = Path.GetPathRoot(directory);
                if (root is null) return false;
                var cursor = root;
                var pieces = directory.Substring(root.Length).Split('\\',
                    StringSplitOptions.RemoveEmptyEntries);
                if (pieces.Length > 40) return false;
                // All ancestors must exist without reparse, and the final
                // index location must already exist (no mkdir at qualification).
                var steps = new List<string> { cursor };
                foreach (var name in pieces) {
                    cursor = Path.Combine(cursor, name);
                    steps.Add(cursor);
                }
                foreach (var step in steps)
                {
                    using var probe = CreateFileW(step, ReadAttributes, FileShareReadWriteDelete,
                        0, OpenExisting, BackupSemantics | OpenReparsePoint, 0);
                    if (probe.IsInvalid || !GetFileInformationByHandle(probe, out var info) ||
                        (info.FileAttributes & 0x410) != 0x10) return false;
                }
                using var handle = CreateFileW(directory, ReadControl | ReadAttributes,
                    FileShareReadWriteDelete, 0, OpenExisting,
                    BackupSemantics | OpenReparsePoint, 0);
                if (handle.IsInvalid) return false;
                if (GetSecurityInfo(handle, 1, OwnerSecurity | DaclSecurity,
                    out _, out _, out _, out _, out var sd) != 0 || sd == 0) return false;
                try
                {
                    if (!EffectiveGrantedAccess(sd, impersonation, out var allowed))
                        return false;
                    // SQLite index, WAL, SHM and writerlock companion require
                    // new files/subdirectories, modifications and delete-child.
                    const uint needed = 0x00000002 | 0x00000004 | 0x00000040;
                    return (allowed & needed) == needed;
                }
                finally { LocalFree(sd); }
            }
            finally { CloseHandle(impersonation); }
        }
        catch { return false; }
        finally { CloseHandle(token); }
    }

    private static bool EffectiveGrantedAccess(nint securityDescriptor, nint impersonation,
        out uint granted)
    {
        granted = 0;
        var mapping = new GenericMapping { Read = GenericRead, Write = GenericWrite,
            Execute = GenericExecute, All = GenericAll };
        uint length = 4096;
        var privileges = Marshal.AllocHGlobal((int)length);
        try
        {
            return AccessCheck(securityDescriptor, impersonation, MaximumAllowed,
                ref mapping, privileges, ref length, out granted, out var accessStatus) && accessStatus;
        }
        finally { Marshal.FreeHGlobal(privileges); }
    }

    private static bool SafeTokenPrivileges(nint processToken)
    {
        if (!GetTokenInformation(processToken, 3 /* TokenPrivileges */, 0, 0, out var length) &&
            length is <= 0 or > 65536) return false;
        if (length is <= 0 or > 65536) return false;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(processToken, 3, buffer, length, out _)) return false;
            var count = Marshal.ReadInt32(buffer);
            if (count is < 0 or > 1024 || 4L + 12L * count > length) return false;
            for (var i = 0; i < count; i++)
            {
                var luid = new Luid {
                    LowPart = unchecked((uint)Marshal.ReadInt32(buffer, 4 + i * 12)),
                    HighPart = Marshal.ReadInt32(buffer, 8 + i * 12)
                };
                var name = new System.Text.StringBuilder(128);
                uint nameChars = (uint)name.Capacity;
                if (!LookupPrivilegeNameW(null, ref luid, name, ref nameChars)) return false;
                // A disabled privilege can usually be enabled by the same
                // token holder: fail even when it is not currently enabled.
                if (DangerousPrivileges.Contains(name.ToString())) return false;
            }
            return true;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct GenericMapping
    {
        public uint Read, Write, Execute, All;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Luid
    {
        public uint LowPart; public int HighPart;
    }
    [StructLayout(LayoutKind.Sequential)] private struct NativeFileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint FileAttributes;
        public NativeFileTime Creation, LastAccess, LastWrite;
        public uint VolumeSerial, SizeHigh, SizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        nint securityAttributes, uint creation, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(nint process, uint rights, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(nint token, uint access, nint attributes,
        int impersonationLevel, int tokenType, out nint duplicate);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(nint token, int type, nint buffer, int length, out int needed);
    [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeNameW(string? system, ref Luid luid,
        System.Text.StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType,
        uint flags, out nint owner, out nint group, out nint dacl, out nint sacl, out nint descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool IsValidSid(nint sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAce(nint acl, uint index, out nint ace);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AccessCheck(nint descriptor, nint clientToken, uint desired,
        ref GenericMapping mapping, nint privilegeSet, ref uint privilegeLength,
        out uint granted, [MarshalAs(UnmanagedType.Bool)] out bool accessStatus);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint LocalFree(nint allocation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);
}
