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

if (-not (Test-Path -LiteralPath $current -PathType Container) -or
    -not (Test-Path -LiteralPath $previous -PathType Container)) { throw 'Current and previous releases required.' }
$trayExe = Join-Path $current 'tray/HostDeck.Tray.exe'
$nodeExe = Join-Path $current 'agent/node.exe'
foreach ($process in Get-CimInstance -ClassName Win32_Process -Filter "Name='HostDeck.Tray.exe' OR Name='node.exe'") {
    if ($process.ExecutablePath -in @($trayExe, $nodeExe)) { throw 'Stop the HostDeck user tray and agent before rollback.' }
}
Verify-Release $current
Verify-Release $previous
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
    Start-Service -Name HostDeck -ErrorAction Stop
    (Get-Service -Name HostDeck).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
} catch {
    if ($movedPrevious -and (Test-Path -LiteralPath $current)) { Move-Item -LiteralPath $current -Destination $previous }
    if ($movedCurrent -and (Test-Path -LiteralPath $failed)) { Move-Item -LiteralPath $failed -Destination $current }
    if ($stopped) { Start-Service -Name HostDeck -ErrorAction SilentlyContinue }
    throw
}
