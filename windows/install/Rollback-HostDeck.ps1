param([Parameter(Mandatory)] [string] $InstallRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator required.' }
if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be absolute.' }
$root = [IO.Path]::GetFullPath($InstallRoot)
$current = Join-Path $root 'current'
$previous = Join-Path $root 'previous'

function Assert-NoReparse([string] $path) {
    $part = [IO.Path]::GetFullPath($path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $entry = Get-Item -LiteralPath $part -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in release path.' }
        }
        $parentPart = Split-Path -Parent $part
        if (-not $parentPart -or $parentPart -eq $part) { break }
        $part = $parentPart
    }
    foreach ($entry in Get-ChildItem -LiteralPath $path -Recurse -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in release tree.' }
    }
}

function Verify-Release([string] $source) {
    Assert-NoReparse $source
    $manifestPath = Join-Path $source 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Missing release manifest.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or @($manifest.files).Count -lt 3) { throw 'Invalid release manifest.' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $manifest.files) {
        $relative = [string]$item.path
        if ($relative -notmatch '^(agent|desktop|service|tray|installer|licenses)/' -or
            $relative -match '[\\:\x00-\x1f]' -or @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or
            -not $paths.Add($relative)) { throw 'Unsafe release manifest path.' }
        $file = Join-Path $source $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne [string]$item.sha256) { throw 'Release hash mismatch.' }
    }
    foreach ($required in @('service/HostDeck.Lifecycle.exe', 'desktop/HostDeck.DesktopWorker.exe', 'tray/HostDeck.Tray.exe')) {
        if (-not $paths.Contains($required)) { throw 'Incomplete previous release.' }
    }
}

function Get-WorkerReleaseHash([string] $release) {
    $binary = Join-Path $release 'desktop/HostDeck.DesktopWorker.exe'
    $manifest = Get-Content -LiteralPath (Join-Path $release 'manifest.json') -Raw | ConvertFrom-Json
    $entries = @($manifest.files | Where-Object { $_.path -ceq 'desktop/HostDeck.DesktopWorker.exe' })
    if ($entries.Count -ne 1) { throw 'Desktop worker missing from verified release manifest.' }
    $actual = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
    if ($actual -ne [string]$entries[0].sha256) { throw 'Desktop worker release hash mismatch.' }
    return $actual.ToLowerInvariant()
}

function Get-WorkerConfigState([string] $configPath, [string] $releaseRoot) {
    $bytes = [IO.File]::ReadAllBytes($configPath)
    $value = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $json = if ($value.Length -gt 0 -and $value[0] -eq [char]0xfeff) { $value.Substring(1) } else { $value }
    $parsed = $json | ConvertFrom-Json
    $expectedPath = Join-Path $releaseRoot 'current/desktop/HostDeck.DesktopWorker.exe'
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$parsed.desktop_worker),
            [IO.Path]::GetFullPath($expectedPath), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Configured desktop worker path is not bound to current release.'
    }
    $matches = [regex]::Matches($value, '"desktop_worker_sha256"\s*:\s*"([a-fA-F0-9]{64})"')
    if ($matches.Count -ne 1 -or [string]$parsed.desktop_worker_sha256 -ne $matches[0].Groups[1].Value) {
        throw 'Configured desktop worker pin missing or ambiguous.'
    }
    return @{ Bytes = $bytes; Text = $value; Match = $matches[0]; Hash = $matches[0].Groups[1].Value.ToLowerInvariant() }
}

function Set-WorkerConfigHash([string] $configPath, [hashtable] $original, [string] $newHash) {
    if ($original.Hash -eq $newHash) { return $null }
    $old = $original.Match
    $replacement = $original.Text.Substring(0, $old.Groups[1].Index) + $newHash +
        $original.Text.Substring($old.Groups[1].Index + $old.Groups[1].Length)
    $temporary = $configPath + '.stage-' + [guid]::NewGuid().ToString('N')
    $backup = $configPath + '.worker-pin-backup-' + [guid]::NewGuid().ToString('N')
    try {
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -ne [Convert]::ToBase64String($original.Bytes)) {
            throw 'Protected facade config changed during release transaction.'
        }
        [IO.File]::WriteAllBytes($temporary, [Text.Encoding]::UTF8.GetBytes($replacement))
        [IO.File]::Replace($temporary, $configPath, $backup)
        return $backup
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Restore-WorkerConfig([string] $configPath, [string] $backup, [hashtable] $original) {
    if ($backup) {
        $discard = $configPath + '.failed-pin-' + [guid]::NewGuid().ToString('N')
        [IO.File]::Replace($backup, $configPath, $discard)
        Remove-Item -LiteralPath $discard -Force
    }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -ne [Convert]::ToBase64String($original.Bytes)) {
        throw 'Original protected facade bytes not restored; refusing service restart.'
    }
}

if (-not (Test-Path -LiteralPath $current -PathType Container) -or
    -not (Test-Path -LiteralPath $previous -PathType Container)) { throw 'Current and previous releases required.' }
$trayExe = Join-Path $current 'tray/HostDeck.Tray.exe'
$nodeExe = Join-Path $current 'agent/node.exe'
foreach ($process in Get-CimInstance -ClassName Win32_Process -Filter "Name='HostDeck.Tray.exe' OR Name='node.exe'") {
    if ($process.ExecutablePath -in @($trayExe, $nodeExe)) { throw 'Stop the HostDeck user tray and agent before rollback.' }
}
Verify-Release $current
Verify-Release $previous
$facadeConfig = Join-Path $root 'config/facade.json'
Assert-NoReparse $facadeConfig
$originalWorker = Get-WorkerConfigState $facadeConfig $root
if ($originalWorker.Hash -ne (Get-WorkerReleaseHash $current)) { throw 'Current worker pin does not match installed release.' }
$rollbackWorkerHash = Get-WorkerReleaseHash $previous
$configBackup = $null
$failed = Join-Path $root ('rolled-back-' + [guid]::NewGuid().ToString('N'))
$movedCurrent = $false
$movedPrevious = $false
$stopped = $false
try {
    Stop-Service -Name HostDeck -ErrorAction Stop
    (Get-Service -Name HostDeck).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    $stopped = $true
    Move-Item -LiteralPath $current -Destination $failed
    $movedCurrent = $true
    Move-Item -LiteralPath $previous -Destination $current
    $movedPrevious = $true
    $configBackup = Set-WorkerConfigHash $facadeConfig $originalWorker $rollbackWorkerHash
    Start-Service -Name HostDeck -ErrorAction Stop
    (Get-Service -Name HostDeck).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
} catch {
    if ($movedPrevious -and (Test-Path -LiteralPath $current)) { Move-Item -LiteralPath $current -Destination $previous }
    if ($movedCurrent -and (Test-Path -LiteralPath $failed)) { Move-Item -LiteralPath $failed -Destination $current }
    Restore-WorkerConfig $facadeConfig $configBackup $originalWorker
    if ($stopped) { Start-Service -Name HostDeck -ErrorAction SilentlyContinue }
    throw
}

if ($configBackup) { Remove-Item -LiteralPath $configBackup -Force }
