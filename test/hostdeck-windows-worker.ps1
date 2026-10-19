param([string] $WorkerExecutable = 'windows/HostDeck.DesktopWorker/bin/Debug/net10.0-windows10.0.19041.0/HostDeck.DesktopWorker.exe')
$ErrorActionPreference = 'Stop'
$worker = (Resolve-Path -LiteralPath $WorkerExecutable).Path
$identity = (& $worker --identity | ConvertFrom-Json)
if (-not $identity.sid -or -not $identity.logon_id -or $identity.session_id -le 0) { throw 'OS identity handshake incomplete.' }
$wrong = ('{"id":"wrong","operation":"hostdeck_list_windows","args":{"session_id":0}}' |
    & $worker --stdio | ConvertFrom-Json)
if ($wrong.id -ne 'wrong' -or $wrong.error.code -ne 'WRONG_SESSION') { throw 'Session 0 was not denied.' }
$unknown = (@{ id = 'unknown'; operation = 'hostdeck_unregistered'; args = @{ session_id = $identity.session_id } } |
    ConvertTo-Json -Compress | & $worker --stdio | ConvertFrom-Json)
if ($unknown.error.code -ne 'UNKNOWN_OPERATION') { throw 'Unknown operation was not denied.' }
$workspace = Join-Path $env:TEMP ('hostdeck-runner-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace | Out-Null
$request = @{
    command = 'echo hostdeck-runner-ok'; cwd = $workspace
    shellExecutable = (Join-Path $env:WINDIR 'System32/cmd.exe'); timeoutSeconds = 10
    stdoutPath = (Join-Path $workspace 'stdout.txt'); stderrPath = (Join-Path $workspace 'stderr.txt')
    receiptPath = (Join-Path $workspace 'receipt.json'); cancelPath = (Join-Path $workspace 'cancel')
}
$request | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $workspace 'request.json')
& $worker --run-job (Join-Path $workspace 'request.json')
$receipt = Get-Content -LiteralPath $request.receiptPath -Raw | ConvertFrom-Json
if ($receipt.status -ne 'completed' -or $receipt.exitCode -ne 0 -or -not $receipt.descendantsContained) {
    throw 'Job Object runner did not produce a successful receipt.'
}
if ((Get-Content -LiteralPath $request.stdoutPath -Raw).Trim() -ne 'hostdeck-runner-ok') {
    throw 'Job stdout did not match.'
}
Write-Output 'Windows worker identity, deny cases and native job runner passed.'
