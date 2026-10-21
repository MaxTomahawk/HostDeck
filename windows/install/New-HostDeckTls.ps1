[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Directory
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Run this script with PowerShell 7 or later.'
}
if (-not [System.IO.Path]::IsPathRooted($Directory)) {
    throw 'Directory must be an absolute private installed-state path.'
}

$fullDirectory = [System.IO.Path]::GetFullPath($Directory)
$volumeRoot = [System.IO.Path]::GetPathRoot($fullDirectory)
if ($fullDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) -eq $volumeRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) {
    throw 'Refusing to use a volume root as the TLS directory.'
}

function Assert-NoReparsePath([string] $Path) {
    $root = [System.IO.Path]::GetPathRoot($Path)
    $cursor = $root
    $parts = $Path.Substring($root.Length).Split([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries)
    foreach ($part in $parts) {
        $cursor = [System.IO.Path]::Combine($cursor, $part)
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'TLS path contains a reparse point.'
            }
        }
    }
}

function New-RestrictedAcl([bool] $IsDirectory, [string] $UserSid) {
    $acl = if ($IsDirectory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $identities = [System.Collections.Generic.Dictionary[string, System.Security.Principal.SecurityIdentifier]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($sidText in @($UserSid, 'S-1-5-18', 'S-1-5-32-544')) {
        if (-not $identities.ContainsKey($sidText)) {
            $identities.Add($sidText, [System.Security.Principal.SecurityIdentifier]::new($sidText))
        }
    }
    foreach ($sid in $identities.Values) {
        $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
        if ($IsDirectory) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights,
                [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
                [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        } else {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)
        }
        [void] $acl.AddAccessRule($rule)
    }
    return $acl
}

Assert-NoReparsePath $fullDirectory
[void] [System.IO.Directory]::CreateDirectory($fullDirectory)
Assert-NoReparsePath $fullDirectory
$pfxPath = [System.IO.Path]::Combine($fullDirectory, 'backend.pfx')
$pemPath = [System.IO.Path]::Combine($fullDirectory, 'backend.pem')
if ((Test-Path -LiteralPath $pfxPath) -or (Test-Path -LiteralPath $pemPath)) {
    throw 'A backend certificate already exists. Refusing to replace its private key.'
}

$identitySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directoryAcl = New-RestrictedAcl $true $identitySid
Set-Acl -LiteralPath $fullDirectory -AclObject $directoryAcl

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=hostdeck.invalid', $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('hostdeck.invalid')
$request.CertificateExtensions.Add($san.Build())
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
$eku = [System.Security.Cryptography.OidCollection]::new()
[void] $eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
$request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = $notBefore.AddYears(1)
$certificate = $request.CreateSelfSigned($notBefore, $notAfter)
$createdPfx = $false
$createdPem = $false
$pfxBytes = $null
try {
    $pfxBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, [string]::Empty)
    $pemBytes = [System.Text.Encoding]::ASCII.GetBytes("-----BEGIN CERTIFICATE-----`n$([Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks))`n-----END CERTIFICATE-----`n")
    $pfxAcl = New-RestrictedAcl $false $identitySid
    $pemAcl = New-RestrictedAcl $false $identitySid
    $pfxStream = [System.IO.FileStream]::new($pfxPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $createdPfx = $true
    try { $pfxStream.Write($pfxBytes, 0, $pfxBytes.Length); $pfxStream.Flush($true) } finally { $pfxStream.Dispose() }
    Set-Acl -LiteralPath $pfxPath -AclObject $pfxAcl
    $pemStream = [System.IO.FileStream]::new($pemPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $createdPem = $true
    try { $pemStream.Write($pemBytes, 0, $pemBytes.Length); $pemStream.Flush($true) } finally { $pemStream.Dispose() }
    Set-Acl -LiteralPath $pemPath -AclObject $pemAcl
} catch {
    if ($createdPem -and (Test-Path -LiteralPath $pemPath)) { Remove-Item -LiteralPath $pemPath -Force }
    if ($createdPfx -and (Test-Path -LiteralPath $pfxPath)) { Remove-Item -LiteralPath $pfxPath -Force }
    throw
} finally {
    if ($pfxBytes) { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length) }
    if ($certificate) { $certificate.Dispose() }
    if ($rsa) { $rsa.Dispose() }
}

# Certificate PEM is public data. Give only backend.pem to the public reverse proxy
# for certificate pinning; backend.pfx and its private key stay in this protected directory.
Write-Output 'Created HostDeck backend TLS certificate files in the configured private directory.'
