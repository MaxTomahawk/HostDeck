// HostDeck read-only source probe, MIT (see repository root LICENSE).
// This is observational metadata, NOT a signing client, authentication oracle,
// driver, process-injection test, enrollment helper or OS authorization decision.
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint ReadControl = 0x20000;
    private const uint TokenQuery = 0x0008;
    private const int AppModelNoPackage = 15700;
    private const int InsufficientBuffer = 122;
    private const int TokenStatisticsClass = 10;
    private const int TokenSessionIdClass = 12;
    private const int TokenIsAppContainerClass = 29;
    private const uint SeKernelObject = 6;
    private const uint OwnerAndDaclInformation = 0x00000001 | 0x00000004;

    private sealed class Observation
    {
        internal string ProcessQuery = "unknown";
        internal string ProcessCreationTime = "unknown";
        internal string ExecutablePathAccessible = "unknown";
        internal string PackageProcess = "unknown";
        internal string PackageToken = "unknown";
        internal string PackageProcessTokenMatch = "unknown";
        internal string AppContainer = "unknown";
        internal string DaclReadable = "unknown";
        internal string DaclPointer = "unknown";
        internal string OwnerEqualsTokenUser = "unknown";
        internal string TokenAvailable = "unknown";
        internal SecurityIdentifier? User;
        internal string? LogonIdentity;
        internal int? Session;
        internal string? ProcessPackageValue; // NEVER serialized
        internal string? TokenPackageValue;   // NEVER serialized
    }

    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || args.Length != 2 ||
            !int.TryParse(args[0], out int candidatePid) || candidatePid <= 0 ||
            !int.TryParse(args[1], out int comparisonPid) || comparisonPid <= 0 ||
            candidatePid == comparisonPid)
        {
            Console.Error.WriteLine("BOUNDARY_PROBE_USAGE: two distinct, privately selected positive PIDs; Windows only.");
            return 64;
        }

        // Two named process objects are queried with minimum read-only rights.
        // No process enumeration, key lookup, signature, network request or effect.
        var candidate = Inspect(candidatePid);
        var other = Inspect(comparisonPid);
        var publicReport = new
        {
            schema = 1,
            evidence = "SOURCE_ONLY_READ_ONLY_PROCESS_METADATA_NOT_CLIENT_AUTHENTICATION",
            candidate = SafeView(candidate),
            comparison = SafeView(other),
            comparisons = new
            {
                same_user_sid = Compare(candidate.User?.Value, other.User?.Value),
                same_logon_authentication_id = Compare(candidate.LogonIdentity, other.LogonIdentity),
                same_token_session = Compare(candidate.Session, other.Session),
                same_full_package_identity = Compare(candidate.ProcessPackageValue, other.ProcessPackageValue)
            },
            not_tested = new[]
            {
                "private_key_access", "client_signing", "signer_or_publisher_attestation",
                "package_publisher_trust", "image_memory_integrity",
                "effective_process_access_or_injection", "parent_chain_integrity",
                "gui_automation", "protected_signer_channel", "SYSTEM_broker",
                "purpose_or_mandate_authorization"
            },
            conclusion = "NO_INTENDED_CLIENT_PROOF_FROM_METADATA_OR_SAME_SID_KEY"
        };
        // There are no raw SIDs, package IDs, paths, PIDs, logon IDs or ACEs
        // in this output. Raw kernel observations remain local memory only.
        Console.WriteLine(JsonSerializer.Serialize(publicReport));
        return candidate.ProcessQuery == "yes" && other.ProcessQuery == "yes"
            && candidate.TokenAvailable == "yes" && other.TokenAvailable == "yes" ? 0 : 2;
    }

    private static object SafeView(Observation p) => new
    {
        process_query = p.ProcessQuery,
        creation_time_observable = p.ProcessCreationTime,
        image_location_accessible = p.ExecutablePathAccessible,
        package_from_process = p.PackageProcess,
        package_from_token = p.PackageToken,
        package_process_token_equal = p.PackageProcessTokenMatch,
        app_container_token = p.AppContainer,
        token_query = p.TokenAvailable,
        process_security_descriptor_readable = p.DaclReadable,
        process_dacl_pointer = p.DaclPointer,
        process_owner_equals_token_user = p.OwnerEqualsTokenUser,
        executable_signature = "not_checked",
        isolation_or_authentication = "not_established"
    };

    private static string Compare<T>(T? a, T? b)
        => a is null || b is null ? "unknown" : EqualityComparer<T>.Default.Equals(a, b) ? "yes" : "no";

    private static Observation Inspect(int pid)
    {
        var observed = new Observation();
        IntPtr handle = Native.OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero) return observed;
        try
        {
            observed.ProcessQuery = "yes";
            observed.ProcessCreationTime = Native.GetProcessTimes(handle,
                out long created, out _, out _, out _) && created != 0 ? "yes" : "unknown";

            var imageBuffer = new StringBuilder(4096);
            int chars = imageBuffer.Capacity;
            observed.ExecutablePathAccessible =
                Native.QueryFullProcessImageName(handle, 0, imageBuffer, ref chars) ? "yes" : "unknown";
            // Do not copy, serialize, hash, resolve, display or open the image path.

            (observed.PackageProcess, observed.ProcessPackageValue) = ReadPackage(
                (ref uint size, StringBuilder? name) => Native.GetPackageFullName(handle, ref size, name));
            if (Native.OpenProcessToken(handle, TokenQuery, out IntPtr token))
            {
                try
                {
                    observed.TokenAvailable = "yes";
                    using var identity = new WindowsIdentity(token);
                    observed.User = identity.User;
                    (observed.PackageToken, observed.TokenPackageValue) = ReadPackage(
                        (ref uint size, StringBuilder? name) => Native.GetPackageFullNameFromToken(token, ref size, name));
                    observed.PackageProcessTokenMatch =
                        Compare(observed.ProcessPackageValue, observed.TokenPackageValue);
                    if (Native.GetTokenInformationInt(token, TokenIsAppContainerClass,
                        out int appContainer, sizeof(int), out _))
                        observed.AppContainer = appContainer != 0 ? "yes" : "no";
                    if (Native.GetTokenInformationInt(token, TokenSessionIdClass,
                        out int session, sizeof(int), out _))
                        observed.Session = session;
                    observed.LogonIdentity = ReadLogonIdentity(token);
                }
                catch
                {
                    // Insufficient token metadata is unknown, never a denial
                    // or a positive intended-client authentication claim.
                }
                finally { Native.CloseHandle(token); }
            }
        }
        finally { Native.CloseHandle(handle); }

        // Process owner/DACL require READ_CONTROL, requested on a separate
        // handle. Never request VM_WRITE, CREATE_THREAD, DEBUG or WRITE_DAC.
        IntPtr aclHandle = Native.OpenProcess(ReadControl, false, pid);
        if (aclHandle == IntPtr.Zero) return observed;
        try
        {
            uint result = Native.GetSecurityInfo(aclHandle, SeKernelObject,
                OwnerAndDaclInformation, out IntPtr owner,
                IntPtr.Zero, out IntPtr dacl, IntPtr.Zero, out IntPtr descriptor);
            try
            {
                if (result == 0)
                {
                    observed.DaclReadable = "yes";
                    observed.DaclPointer = dacl == IntPtr.Zero ? "null_or_absent" : "present";
                    if (owner != IntPtr.Zero && observed.User != null)
                    {
                        var ownerSid = new SecurityIdentifier(owner);
                        observed.OwnerEqualsTokenUser = ownerSid.Equals(observed.User) ? "yes" : "no";
                    }
                }
            }
            finally { if (descriptor != IntPtr.Zero) Native.LocalFree(descriptor); }
        }
        finally { Native.CloseHandle(aclHandle); }
        return observed;
    }

    private delegate int PackageReader(ref uint capacity, StringBuilder? output);
    private static (string Presence, string? Value) ReadPackage(PackageReader read)
    {
        try
        {
            uint chars = 0;
            int status = read(ref chars, null);
            if (status == AppModelNoPackage) return ("absent", null);
            if (status != InsufficientBuffer || chars < 2 || chars > 2048)
                return ("unknown", null);
            var buffer = new StringBuilder((int)chars);
            status = read(ref chars, buffer);
            return status == 0 ? ("present", buffer.ToString()) : ("unknown", null);
        }
        catch { return ("unknown", null); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { internal uint LowPart; internal int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenStatistics
    {
        internal Luid TokenId;
        internal Luid AuthenticationId;
        internal long ExpirationTime;
        internal int TokenType, ImpersonationLevel;
        internal uint DynamicCharged, DynamicAvailable, GroupCount, PrivilegeCount;
        internal Luid ModifiedId;
    }

    private static string? ReadLogonIdentity(IntPtr token)
    {
        int expected = Marshal.SizeOf<TokenStatistics>();
        IntPtr buffer = Marshal.AllocHGlobal(expected);
        try
        {
            if (!Native.GetTokenInformationBuffer(token, TokenStatisticsClass,
                buffer, expected, out int returned) || returned < expected) return null;
            var value = Marshal.PtrToStructure<TokenStatistics>(buffer).AuthenticationId;
            // Compared inside this process only. Never serialized or logged.
            return value.HighPart.ToString("x8") + value.LowPart.ToString("x8");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static class Native
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetProcessTimes(IntPtr process,
            out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern bool QueryFullProcessImageName(IntPtr process, int flags,
            StringBuilder name, ref int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetPackageFullName")]
        internal static extern int GetPackageFullName(IntPtr process,
            ref uint capacity, StringBuilder? name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetPackageFullNameFromToken")]
        internal static extern int GetPackageFullNameFromToken(IntPtr token,
            ref uint capacity, StringBuilder? name);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
        [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformationInt(IntPtr token, int infoClass,
            out int value, int length, out int resultLength);
        [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformationBuffer(IntPtr token, int infoClass,
            IntPtr buffer, int length, out int resultLength);
        [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo")]
        internal static extern uint GetSecurityInfo(IntPtr process, uint objectType, uint flags,
            out IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
        [DllImport("kernel32.dll")]
        internal static extern IntPtr LocalFree(IntPtr allocated);
    }
}
