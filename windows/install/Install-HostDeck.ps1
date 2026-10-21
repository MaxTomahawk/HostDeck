param(
    [Parameter(Mandatory)] [string] $PackageDirectory,
    [Parameter(Mandatory)] [string] $InstallRoot,
    [Parameter(Mandatory)] [string] $EnrolledUserSid,
    [string] $FacadeConfigPath,
    [string] $GrantsPath,
    [string] $StateDirectory,
    [switch] $RecoverFailedFreshInstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrative install token required.'
    }
}

function Assert-NoReparsePath([string] $path) {
    $part = [IO.Path]::GetFullPath($path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $entry = Get-Item -LiteralPath $part -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in protected path: $part" }
        }
        $parentPart = Split-Path -Parent $part
        if (-not $parentPart -or $parentPart -eq $part) { break }
        $part = $parentPart
    }
}

function Assert-NoReparseTree([string] $path) {
    Assert-NoReparsePath $path
    foreach ($entry in Get-ChildItem -LiteralPath $path -Recurse -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in package: $($entry.FullName)" }
    }
}

function Set-ExactAcl([string] $path, [string] $profile, [bool] $recursive = $false) {
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $userSid = [Security.Principal.SecurityIdentifier]::new($EnrolledUserSid)
    $localServiceSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $entries = @(Get-Item -LiteralPath $path -Force)
    if ($recursive) { $entries += @(Get-ChildItem -LiteralPath $path -Recurse -Force) }
    foreach ($entry in $entries) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in protected tree: $($entry.FullName)" }
        $acl = if ($entry.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($adminSid)
        $inherit = if ($entry.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rules = @(@($systemSid, 'FullControl'), @($adminSid, 'FullControl'))
        switch ($profile) {
            'release' { $rules += @(@($usersSid, 'ReadAndExecute'), @($localServiceSid, 'ReadAndExecute')) }
            'config' { $rules += ,@($userSid, 'ReadAndExecute') }
            'state' { $rules += ,@($userSid, 'Modify') }
            'enrollment' { $rules += @(@($localServiceSid, 'Modify'), @($userSid, 'Read')) }
            'service-config' { $rules += ,@($localServiceSid, 'Read') }
            default { throw "Unknown ACL profile: $profile" }
        }
        foreach ($rule in $rules) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($rule[0], [Security.AccessControl.FileSystemRights]$rule[1], $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        Set-Acl -LiteralPath $entry.FullName -AclObject $acl
    }
}

function Verify-Package([string] $source) {
    $manifestPath = Join-Path $source 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Missing manifest.json.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or @($manifest.files).Count -lt 3) { throw 'Invalid manifest.' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $manifest.files) {
        $relative = [string]$item.path
        if ($relative -notmatch '^(agent|desktop|service|tray|installer|licenses)/' -or
            $relative -match '[\\:\x00-\x1f]' -or @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or
            -not $paths.Add($relative)) { throw 'Unsafe package path.' }
        $file = Join-Path $source $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing package file.' }
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($hash -ne [string]$item.sha256) { throw 'Package hash mismatch.' }
    }
    foreach ($required in @('service/HostDeck.Lifecycle.exe', 'desktop/HostDeck.DesktopWorker.exe', 'tray/HostDeck.Tray.exe',
            'agent/node.exe', 'agent/dist/hostdeck/main.js', 'agent/ui/newtree/index.html', 'licenses/Node.LICENSE')) {
        if (-not $paths.Contains($required)) { throw 'Missing required package file.' }
    }
    return $manifest
}

Assert-Administrator
$null = [Security.Principal.SecurityIdentifier]::new($EnrolledUserSid)
$package = (Resolve-Path -LiteralPath $PackageDirectory).Path
$root = [IO.Path]::GetFullPath($InstallRoot)
if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be absolute.' }
Assert-NoReparseTree $package
Assert-NoReparsePath $root
if ($package.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package must be outside InstallRoot.'
}
$manifest = Verify-Package $package
$parent = Split-Path -Parent $root
if (Test-Path -LiteralPath $root) {
    $registered = Get-CimInstance -ClassName Win32_Service -Filter "Name='HostDeck'" -ErrorAction SilentlyContinue
    if (-not $registered -and $RecoverFailedFreshInstall) {
        $markerPath = Join-Path $root 'fresh-install-recovery.json'
        Assert-NoReparsePath $markerPath
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or -not $StateDirectory) { throw 'No recoverable fresh install marker or state path.' }
        $rootAcl = Get-Acl -LiteralPath $root
        $adminSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        if (-not $rootAcl.AreAccessRulesProtected -or $rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $adminSid.Value) {
            throw 'Failed install root is not protected and administrator-owned.'
        }
        $allowedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545', 'S-1-5-19')
        foreach ($rule in $rootAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.IdentityReference.Value -notin $allowedSids -or
                ($rule.IdentityReference.Value -in @('S-1-5-32-545','S-1-5-19') -and
                    (([int]$rule.FileSystemRights -band (-bnot [int][Security.AccessControl.FileSystemRights]::ReadAndExecute)) -ne 0))) {
                throw 'Failed install root has unexpected access.'
            }
        }
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        $stateForRecovery = [IO.Path]::GetFullPath($StateDirectory)
        $protectedConfig = Get-Content -LiteralPath (Join-Path $root 'config/facade.json') -Raw | ConvertFrom-Json
        $manifestHash = (Get-FileHash -LiteralPath (Join-Path $package 'manifest.json') -Algorithm SHA256).Hash
        if ($marker.schema -ne 1 -or $marker.install_root -ne $root -or $marker.enrolled_user_sid -ne $EnrolledUserSid -or
            $marker.state_directory -ne $stateForRecovery -or $marker.package_manifest_sha256 -ne $manifestHash -or
            $marker.device_id -ne $protectedConfig.device_id -or $protectedConfig.state_directory -ne $stateForRecovery -or
            -not (Test-Path -LiteralPath $stateForRecovery -PathType Container)) { throw 'Failed install identity does not match package and state.' }
        Assert-NoReparseTree $root
        Assert-NoReparseTree $stateForRecovery
        $stateAcl = Get-Acl -LiteralPath $stateForRecovery
        if (-not $stateAcl.AreAccessRulesProtected -or $stateAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $adminSid.Value) {
            throw 'Failed install state is not protected and administrator-owned.'
        }
        $suffix = '.failed-' + [guid]::NewGuid().ToString('N')
        $rootDiagnostic = $root + $suffix
        $stateDiagnostic = $stateForRecovery + $suffix
        if ((Test-Path -LiteralPath $rootDiagnostic) -or (Test-Path -LiteralPath $stateDiagnostic)) { throw 'Diagnostic path collision.' }
        Move-Item -LiteralPath $root -Destination $rootDiagnostic
        try { Move-Item -LiteralPath $stateForRecovery -Destination $stateDiagnostic }
        catch { Move-Item -LiteralPath $rootDiagnostic -Destination $root; throw }
    } elseif ($RecoverFailedFreshInstall) { throw 'Recovery applies only when no HostDeck service is registered.' }
}
if (Test-Path -LiteralPath $root) {
    $registered = Get-CimInstance -ClassName Win32_Service -Filter "Name='HostDeck'" -ErrorAction SilentlyContinue
    $expectedServicePath = Join-Path $root 'current/service/HostDeck.Lifecycle.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $root 'service-config.json') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $root 'config/facade.json') -PathType Leaf) -or
        -not $registered -or -not $registered.PathName.StartsWith(('"' + $expectedServicePath + '" '), [StringComparison]::OrdinalIgnoreCase) -or
        $registered.StartName -ne 'NT AUTHORITY\LocalService') { throw 'Existing install root is not a trusted HostDeck release.' }
    $trayExe = Join-Path $root 'current/tray/HostDeck.Tray.exe'
    $nodeExe = Join-Path $root 'current/agent/node.exe'
    foreach ($process in Get-CimInstance -ClassName Win32_Process -Filter "Name='HostDeck.Tray.exe' OR Name='node.exe'") {
        if ($process.ExecutablePath -in @($trayExe, $nodeExe)) { throw 'Stop the HostDeck user tray and agent before updating.' }
    }
}
New-Item -ItemType Directory -Force -Path $parent | Out-Null
New-Item -ItemType Directory -Force -Path $root | Out-Null
Assert-NoReparsePath $root
Set-ExactAcl $root 'release'
$stage = Join-Path $root ('stage-' + [guid]::NewGuid().ToString('N'))
$current = Join-Path $root 'current'
$previous = Join-Path $root 'previous'
$serviceConfig = Join-Path $root 'service-config.json'
$enrollmentDirectory = Join-Path $root 'enrollment'
$facadeConfig = Join-Path $root 'config/facade.json'
$protectedGrants = Join-Path $root 'config/grants.json'
$recoveryMarker = Join-Path $root 'fresh-install-recovery.json'
$existing = Get-Service -Name HostDeck -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $serviceConfig) {
    Assert-NoReparsePath $serviceConfig
    Assert-NoReparseTree (Split-Path -Parent $facadeConfig)
    Set-ExactAcl (Split-Path -Parent $facadeConfig) 'config' $true
    Set-ExactAcl $serviceConfig 'service-config'
    $oldSid = (Get-Content -LiteralPath $serviceConfig -Raw | ConvertFrom-Json).enrolled_user_sid
    if ($oldSid -ne $EnrolledUserSid) { throw 'Enrollment SID change requires a separate authorized transaction.' }
}
if (-not (Test-Path -LiteralPath $facadeConfig)) {
    if (-not $FacadeConfigPath -or -not $GrantsPath -or -not $StateDirectory) {
        throw 'Initial install requires FacadeConfigPath, GrantsPath and StateDirectory.'
    }
    $sourceConfig = Get-Content -LiteralPath $FacadeConfigPath -Raw | ConvertFrom-Json
    if ($sourceConfig.expected_user_sid -ne $EnrolledUserSid -or $sourceConfig.version -ne 1) {
        throw 'Facade identity or version mismatch.'
    }
    $originalDeviceId = [string]$sourceConfig.device_id
    if ($originalDeviceId -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Invalid prepared device ID.' }
    $deviceBytes = New-Object byte[] 16
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($deviceBytes) } finally { $random.Dispose() }
    $deviceId = [BitConverter]::ToString($deviceBytes).Replace('-', '').ToLowerInvariant()
    $sourceGrants = @(Get-Content -LiteralPath $GrantsPath -Raw | ConvertFrom-Json)
    $matchingGrants = 0
    foreach ($grant in $sourceGrants) {
        if ($grant.deviceId -eq $originalDeviceId) { $grant.deviceId = $deviceId; $matchingGrants++ }
    }
    if ($matchingGrants -lt 1) { throw 'No prepared grant matches device ID.' }
    $state = [IO.Path]::GetFullPath($StateDirectory)
    Assert-NoReparsePath $state
    if (-not [IO.Path]::IsPathRooted($StateDirectory) -or -not [IO.Path]::IsPathRooted($sourceConfig.workspace)) {
        throw 'Absolute state and workspace paths required.'
    }
    $workspace = [IO.Path]::GetFullPath([string]$sourceConfig.workspace).TrimEnd('\')
    if ($state.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase) -or $state -eq $workspace) {
        throw 'State directory cannot be inside workspace.'
    }
    if ($state.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $state -eq $root) {
        throw 'State directory must be outside InstallRoot for independent recovery.'
    }
    if (Test-Path -LiteralPath $state) { throw 'Initial state directory must be new.' }
    $configDirectory = Split-Path -Parent $facadeConfig
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $state | Out-Null
    $sourceConfig.desktop_worker = Join-Path $current 'desktop/HostDeck.DesktopWorker.exe'
    $sourceConfig.device_id = $deviceId
    $sourceConfig.grants_file = $protectedGrants
    $sourceConfig.state_directory = $state
    $sourceConfig | Add-Member -NotePropertyName installed -NotePropertyValue $true -Force
    $sourceConfig | Add-Member -NotePropertyName enrollment_file -NotePropertyValue (Join-Path $enrollmentDirectory 'device.json') -Force
    $sourceConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $facadeConfig -Encoding utf8
    ConvertTo-Json -InputObject $sourceGrants -Depth 20 | Set-Content -LiteralPath $protectedGrants -Encoding utf8
}
$configDirectory = Split-Path -Parent $facadeConfig
Assert-NoReparseTree $configDirectory
Set-ExactAcl $configDirectory 'config' $true
$state = [IO.Path]::GetFullPath([string](Get-Content -LiteralPath $facadeConfig -Raw | ConvertFrom-Json).state_directory)
Assert-NoReparseTree $state
Set-ExactAcl $state 'state' $true
if (-not (Test-Path -LiteralPath $enrollmentDirectory)) {
    New-Item -ItemType Directory -Path $enrollmentDirectory | Out-Null
}
Assert-NoReparsePath $enrollmentDirectory
Set-ExactAcl $enrollmentDirectory 'enrollment' $true
$deviceId = (Get-Content -LiteralPath $facadeConfig -Raw | ConvertFrom-Json).device_id
if (-not $existing -and -not (Test-Path -LiteralPath $recoveryMarker)) {
    @{ schema = 1; install_root = $root; enrolled_user_sid = $EnrolledUserSid; state_directory = $state;
        package_manifest_sha256 = (Get-FileHash -LiteralPath (Join-Path $package 'manifest.json') -Algorithm SHA256).Hash;
        device_id = $deviceId } | ConvertTo-Json -Compress | Set-Content -LiteralPath $recoveryMarker -Encoding utf8
    Set-ExactAcl $recoveryMarker 'service-config'
}
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in $manifest.files) {
    $relative = [string]$item.path
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $package $relative) -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $package 'manifest.json') -Destination (Join-Path $stage 'manifest.json')
Assert-NoReparseTree $stage
Verify-Package $stage | Out-Null

# Administrators and SYSTEM own release bytes. The selected interactive user
# needs read/execute access but cannot replace the native worker executable.
Set-ExactAcl $stage 'release' $true

$movedOld = $false
$installedNew = $false
$archivedPrevious = $null
try {
    if ($existing) {
        Stop-Service -Name HostDeck -ErrorAction Stop
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    if (Test-Path -LiteralPath $previous) {
        $archive = Join-Path $root ('archive-' + [guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $previous -Destination $archive
        $archivedPrevious = $archive
    }
    if (Test-Path -LiteralPath $current) {
        Move-Item -LiteralPath $current -Destination $previous
        $movedOld = $true
    }
    Move-Item -LiteralPath $stage -Destination $current
    $installedNew = $true
    $servicePath = Join-Path $current 'service/HostDeck.Lifecycle.exe'
    @{ enrolled_user_sid = $EnrolledUserSid; enrollment_directory = $enrollmentDirectory; device_id = $deviceId } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $serviceConfig -Encoding utf8
    Set-ExactAcl $serviceConfig 'service-config'
    if (-not $existing) {
        $serviceCommand = '"' + $servicePath + '" --service "' + $serviceConfig + '"'
        & sc.exe create HostDeck binPath= $serviceCommand obj= 'NT AUTHORITY\LocalService' start= auto | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Service registration failed.' }
        & sc.exe sidtype HostDeck unrestricted | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Service SID registration failed.' }
    }
    & sc.exe failure HostDeck reset= 86400 actions= restart/20000/restart/60000/restart/120000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Service recovery registration failed.' }
    & sc.exe failureflag HostDeck 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Service failure recovery flag registration failed.' }
    Start-Service -Name HostDeck -ErrorAction Stop
    (Get-Service -Name HostDeck).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    if (Test-Path -LiteralPath $recoveryMarker) { Remove-Item -LiteralPath $recoveryMarker -Force }
} catch {
    $installError = $_
    if (-not $existing -and (Get-Service -Name HostDeck -ErrorAction SilentlyContinue)) {
        & sc.exe delete HostDeck | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Install failed and the newly created service could not be removed.' }
    }
    if ($installedNew -and (Test-Path -LiteralPath $current)) {
        $failed = Join-Path $root ('failed-' + [guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $current -Destination $failed
    }
    if ($movedOld) {
        Move-Item -LiteralPath $previous -Destination $current
        Start-Service -Name HostDeck -ErrorAction SilentlyContinue
    } elseif ($existing) {
        Start-Service -Name HostDeck -ErrorAction SilentlyContinue
    }
    if ($archivedPrevious -and (Test-Path -LiteralPath $archivedPrevious)) {
        Move-Item -LiteralPath $archivedPrevious -Destination $previous
    }
    throw $installError
}
Write-Output 'HostDeck service installed. Enroll the user tray separately with Register-HostDeckUser.ps1.'
