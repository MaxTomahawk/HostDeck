param(
    [string] $CloudflaredPath,
    [string] $TunnelId,
    [string] $Hostname,
    [string] $CredentialsFile,
    [string] $ExpectedSha256,
    [switch] $ValidateOnly,
    [switch] $RemoveService
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$serviceName = 'cloudflared'
$serviceDescription = 'HostDeck direct Cloudflare Tunnel'
$configRoot = Join-Path $env:ProgramData 'HostDeck/Cloudflared'
$configPath = Join-Path $configRoot 'config.yml'
$serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator token required.' }
}

function Assert-Inputs {
    if ($TunnelId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'Invalid tunnel ID.' }
    if ($Hostname.Length -gt 253 -or $Hostname -notmatch '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$') { throw 'Invalid public hostname.' }
    if (-not $CloudflaredPath -or -not (Test-Path -LiteralPath $CloudflaredPath -PathType Leaf)) { throw 'cloudflared binary not found.' }
    $resolved = (Resolve-Path -LiteralPath $CloudflaredPath).Path
    if ([IO.Path]::GetExtension($resolved) -ne '.exe') { throw 'A cloudflared executable is required.' }
    if (-not $ExpectedSha256 -or $ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'ExpectedSha256 must be the trusted cloudflared release digest.' }
    $script:CloudflaredBytes = [IO.File]::ReadAllBytes($resolved)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($script:CloudflaredBytes)).Replace('-', '') } finally { $sha.Dispose() }
    if ($actual -ine $ExpectedSha256) { throw 'cloudflared binary digest mismatch.' }
    $script:CloudflaredSourceResolved = $resolved
    $script:CloudflaredHash = $actual
    $script:TunnelIdNormalized = $TunnelId.ToLowerInvariant()
}

function New-ConfigText([string] $CredentialPath) {
    $yamlPath = $CredentialPath.Replace("'", "''")
    $yamlHost = $Hostname.Replace("'", "''")
    return @(
        "tunnel: $TunnelIdNormalized"
        "credentials-file: '$yamlPath'"
        ''
        'ingress:'
        "  - hostname: '$yamlHost'"
        '    service: http://127.0.0.1:18763'
        '  - service: http_status:404'
        ''
    ) -join "`n"
}

function Test-Config([string] $Path) {
    $output = @(& $CloudflaredResolved "--config=$Path" tunnel ingress validate 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'cloudflared rejected the tunnel ingress configuration.' }
}

function Set-PrivateAcl([string] $Path, [bool] $Directory, [switch] $Executable) {
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $serviceSid = [Security.Principal.SecurityIdentifier]::new($script:CloudflaredServiceSid)
    $owner = $admins
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($owner)
    $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @($system, $admins)) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)) }
    $serviceRights = if ($Directory -or $Executable) { [Security.AccessControl.FileSystemRights]::ReadAndExecute } else { [Security.AccessControl.FileSystemRights]::Read }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid, $serviceRights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-Atomic([string] $Path, [byte[]] $Bytes, [switch] $Executable) {
    $temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        Set-PrivateAcl $temporary $false -Executable:$Executable
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
        Set-PrivateAcl $Path $false -Executable:$Executable
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-ExpectedImagePath([string] $Exe) {
    return '"' + $Exe + '" --config="' + $configPath + '" tunnel run'
}

function Get-ServiceDescription {
    if (-not (Test-Path -LiteralPath $serviceKey)) { return $null }
    $properties = Get-ItemProperty -LiteralPath $serviceKey -ErrorAction SilentlyContinue
    if ($properties -and $properties.PSObject.Properties['Description']) { return $properties.Description }
    return $null
}

function Test-OwnedService($Service) {
    return (Get-ServiceDescription) -eq $serviceDescription -and
        ([string]$Service.PathName).IndexOf($configPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-NoReparsePath([string] $Path) {
    $part = [IO.Path]::GetFullPath($Path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in cloudflared protected path.' }
        }
        $parent = Split-Path -Parent $part
        if (-not $parent -or $parent -eq $part) { break }
        $part = $parent
    }
}

function Set-ServiceRegistryValue([string] $Name, [string] $Value, [Microsoft.Win32.RegistryValueKind] $Kind) {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\cloudflared', $true)
    if (-not $key) { throw 'Cloudflared service registry entry is unavailable.' }
    try { $key.SetValue($Name, $Value, $Kind) } finally { $key.Dispose() }
}

function Get-CloudflaredServiceSid {
    $output = @(& sc.exe showsid $serviceName 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not derive the cloudflared service SID.' }
    $match = [regex]::Match(($output -join "`n"), '(?i)S-1-5-80-(?:\d+-){4}\d+')
    if (-not $match.Success) { throw 'Windows did not return a valid cloudflared service SID.' }
    return $match.Value
}

function Set-And-Verify-ServiceSidType {
    $setOutput = @(& sc.exe sidtype $serviceName unrestricted 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enable the cloudflared service SID.' }
    $queryOutput = @(& sc.exe qsidtype $serviceName 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($queryOutput -join "`n") -notmatch '(?i)SERVICE_SID_TYPE:\s*UNRESTRICTED') { throw 'Cloudflared service SID type did not verify as unrestricted.' }
}

function Invoke-ValidateOnly {
    if ($TunnelId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw 'Invalid tunnel ID.' }
    if ($Hostname.Length -gt 253 -or $Hostname -notmatch '^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$') { throw 'Invalid public hostname.' }
    if (-not $CloudflaredPath -or -not (Test-Path -LiteralPath $CloudflaredPath -PathType Leaf)) { throw 'cloudflared validator not found.' }
    $script:CloudflaredResolved = (Resolve-Path -LiteralPath $CloudflaredPath).Path
    $script:TunnelIdNormalized = $TunnelId.ToLowerInvariant()
    $temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $temporaryRoot = Join-Path $temporaryBase ('hostdeck-cloudflared-validate-' + [guid]::NewGuid().ToString('N'))
    $temporaryConfig = Join-Path $temporaryRoot 'config.yml'
    try {
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
        $text = New-ConfigText (Join-Path $temporaryRoot ($TunnelIdNormalized + '.json'))
        [IO.File]::WriteAllText($temporaryConfig, $text, [Text.UTF8Encoding]::new($false))
        Test-Config $temporaryConfig
    } finally {
        $baseFull = [IO.Path]::GetFullPath($temporaryBase).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $targetFull = [IO.Path]::GetFullPath($temporaryRoot)
        $targetParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($targetFull)).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $leaf = [IO.Path]::GetFileName($targetFull)
        if ($targetParent -ine $baseFull -or $leaf -notmatch '^hostdeck-cloudflared-validate-[0-9a-f]{32}$' -or -not $targetFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove an unexpected validation directory.' }
        Assert-NoReparsePath $targetFull
        if (Test-Path -LiteralPath $targetFull) { Remove-Item -LiteralPath $targetFull -Recurse -Force }
    }
    Write-Output 'Tunnel configuration validated.'
}

if ($ValidateOnly) {
    Invoke-ValidateOnly
    return
}

if ($RemoveService) {
    Assert-Administrator
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue
    if (-not $service) { Write-Output 'HostDeck tunnel service is not installed.'; return }
    if (-not (Test-OwnedService $service)) { throw 'The Cloudflared service is not owned by this HostDeck helper; refusing to change it.' }
    if ($service.State -ne 'Stopped') {
        Stop-Service -Name $serviceName -ErrorAction Stop
        (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    $result = @(& sc.exe delete $serviceName 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the HostDeck tunnel service.' }
    Write-Output 'HostDeck tunnel service removed; protected files and cloudflared binary were retained.'
    return
}

Assert-Inputs
Assert-Administrator
$script:CloudflaredServiceSid = Get-CloudflaredServiceSid
Assert-NoReparsePath $configRoot
if (-not $CredentialsFile -or -not (Test-Path -LiteralPath $CredentialsFile -PathType Leaf)) { throw 'Protected tunnel credentials file is required.' }
$credentialBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $CredentialsFile).Path)
if ($credentialBytes.Length -eq 0 -or $credentialBytes.Length -gt 65536) { throw 'Invalid tunnel credentials file size.' }
try { $credential = [Text.Encoding]::UTF8.GetString($credentialBytes) | ConvertFrom-Json } catch { throw 'Tunnel credentials file is invalid.' }
if ($credential.TunnelID -ne $TunnelIdNormalized -or -not $credential.AccountTag -or -not $credential.TunnelSecret) { throw 'Tunnel credentials do not match the selected tunnel.' }

$service = Get-CimInstance -ClassName Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue
$ownedService = $false
if ($service) {
    if (-not (Test-OwnedService $service)) { throw 'A non-HostDeck Cloudflared service already exists; refusing to modify it.' }
    $ownedService = $true
}

New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
Set-PrivateAcl $configRoot $true
$binaryRoot = Join-Path $configRoot 'bin'
New-Item -ItemType Directory -Force -Path $binaryRoot | Out-Null
Set-PrivateAcl $binaryRoot $true
$protectedExecutable = Join-Path $binaryRoot 'cloudflared.exe'
$stagedExecutable = Join-Path $binaryRoot ('.cloudflared-stage-' + [guid]::NewGuid().ToString('N') + '.exe')
$script:CloudflaredResolved = $stagedExecutable
$stageCleanup = $true
try {
    [IO.File]::WriteAllBytes($stagedExecutable, $script:CloudflaredBytes)
    Set-PrivateAcl $stagedExecutable $false -Executable
    Assert-NoReparsePath $stagedExecutable
$credentialPath = Join-Path $configRoot ($TunnelIdNormalized + '.json')
$configBytes = [Text.UTF8Encoding]::new($false).GetBytes((New-ConfigText $credentialPath))
$temporaryConfig = Join-Path $configRoot ('validate-' + [guid]::NewGuid().ToString('N') + '.yml')
try {
    [IO.File]::WriteAllBytes($temporaryConfig, $configBytes)
    Test-Config $temporaryConfig
} finally {
    if ([IO.File]::Exists($temporaryConfig)) { [IO.File]::Delete($temporaryConfig) }
}

$expectedImagePath = Get-ExpectedImagePath $protectedExecutable
$oldBinary = if ([IO.File]::Exists($protectedExecutable)) { [IO.File]::ReadAllBytes($protectedExecutable) } else { $null }
$oldConfig = if ([IO.File]::Exists($configPath)) { [IO.File]::ReadAllBytes($configPath) } else { $null }
$oldCredential = if ([IO.File]::Exists($credentialPath)) { [IO.File]::ReadAllBytes($credentialPath) } else { $null }
$oldImagePath = if (Test-Path -LiteralPath $serviceKey) { (Get-ItemProperty -LiteralPath $serviceKey -Name ImagePath -ErrorAction SilentlyContinue).ImagePath } else { $null }
$oldDescription = Get-ServiceDescription
$oldStartName = if ($service) { $service.StartName } else { $null }
$wasRunning = $service -and $service.State -eq 'Running'
$createdService = $false
$filesChanged = -not ($oldConfig -and [Convert]::ToBase64String($oldConfig) -ceq [Convert]::ToBase64String($configBytes)) -or
    -not ($oldCredential -and [Convert]::ToBase64String($oldCredential) -ceq [Convert]::ToBase64String($credentialBytes))
$oldBinaryHash = if ($oldBinary) { [BitConverter]::ToString([Security.Cryptography.SHA256]::HashData($oldBinary)).Replace('-', '') } else { $null }
$binaryChanged = -not $oldBinary -or $oldBinaryHash -ine $script:CloudflaredHash
$filesChanged = $filesChanged -or $binaryChanged
$serviceChanged = -not $service -or $service.PathName -cne $expectedImagePath -or $service.StartName -ne 'NT AUTHORITY\LocalService'

try {
    if ($service -and $service.State -ne 'Stopped' -and ($filesChanged -or $serviceChanged)) {
        Stop-Service -Name $serviceName -ErrorAction Stop
        (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    if ($binaryChanged) { Write-Atomic $protectedExecutable $script:CloudflaredBytes -Executable }
    $script:CloudflaredResolved = $protectedExecutable
    Write-Atomic $credentialPath $credentialBytes
    Write-Atomic $configPath $configBytes
    if (-not $service) {
        $serviceOutput = @(& $protectedExecutable service install 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'cloudflared could not install its Windows service.' }
        $createdService = $true
        $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue
        if (-not $service) { throw 'cloudflared did not register its Windows service.' }
    }
    Set-ServiceRegistryValue 'ImagePath' $expectedImagePath ([Microsoft.Win32.RegistryValueKind]::ExpandString)
    Set-ServiceRegistryValue 'Description' $serviceDescription ([Microsoft.Win32.RegistryValueKind]::String)
    $scOutput = @(& sc.exe config $serviceName 'obj=' 'NT AUTHORITY\LocalService' 'password=' '' 'start=' 'auto' 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the least-privilege tunnel service account.' }
    Set-And-Verify-ServiceSidType
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='cloudflared'"
    if ($service.PathName -cne $expectedImagePath -or $service.StartName -ne 'NT AUTHORITY\LocalService') { throw 'Cloudflared service configuration did not verify.' }
    if ($service.State -ne 'Running') {
        Start-Service -Name $serviceName -ErrorAction Stop
        (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    } elseif ($filesChanged -or $serviceChanged) {
        Restart-Service -Name $serviceName -ErrorAction Stop
        (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }
} catch {
    if ($createdService) {
        Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
        & sc.exe delete $serviceName *> $null
    } elseif ($ownedService) {
        if ($oldImagePath) { Set-ServiceRegistryValue 'ImagePath' $oldImagePath ([Microsoft.Win32.RegistryValueKind]::ExpandString) }
        if ($oldDescription) { Set-ServiceRegistryValue 'Description' $oldDescription ([Microsoft.Win32.RegistryValueKind]::String) }
        if ($oldStartName -eq 'NT AUTHORITY\LocalService') { & sc.exe config $serviceName 'obj=' 'NT AUTHORITY\LocalService' 'password=' '' *> $null }
        if ($oldStartName -eq 'LocalSystem') { & sc.exe config $serviceName 'obj=' 'LocalSystem' *> $null }
        if ($oldConfig) { Write-Atomic $configPath $oldConfig }
        if ($oldCredential) { Write-Atomic $credentialPath $oldCredential }
        if ($oldBinary) { Write-Atomic $protectedExecutable $oldBinary -Executable }
        elseif ([IO.File]::Exists($protectedExecutable)) { [IO.File]::Delete($protectedExecutable) }
        if ($wasRunning) { Start-Service -Name $serviceName -ErrorAction SilentlyContinue }
    }
    throw 'HostDeck Cloudflared setup failed; prior owned service state was restored where possible.'
}

Write-Output 'HostDeck Cloudflared service is configured.'
} finally {
    if ($stageCleanup -and [IO.File]::Exists($stagedExecutable)) { [IO.File]::Delete($stagedExecutable) }
}
