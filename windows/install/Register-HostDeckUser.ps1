param([Parameter(Mandatory)] [string] $InstallRoot)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run under the unelevated enrolled user token.' }
$root = [IO.Path]::GetFullPath($InstallRoot)
$tray = Join-Path $root 'current/tray/HostDeck.Tray.exe'
$entry = Join-Path $root 'current/agent/dist/hostdeck/main.js'
$NodePath = Join-Path $root 'current/agent/node.exe'
$ConfigPath = Join-Path $root 'config/facade.json'
foreach ($file in @($tray, $entry, $ConfigPath, $NodePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Required user-agent file missing.' }
}
$expectedSid = (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).expected_user_sid
$actualSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($expectedSid -ne $actualSid) { throw 'This user is not the enrolled executor.' }
if (@($tray, $entry, $ConfigPath, $NodePath) | Where-Object { $_.Contains('"') }) { throw 'Quote in path unsupported.' }
$command = '"' + $tray + '" "' + [IO.Path]::GetFullPath($NodePath) + '" "' + $entry + '" "' + [IO.Path]::GetFullPath($ConfigPath) + '"'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name 'HostDeck' -Value $command
Write-Output 'HostDeck user agent registered for this user logon.'
