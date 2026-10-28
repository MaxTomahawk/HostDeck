# Owned Windows fixtures only: no broker task, Explorer, SCM write or installed HostDeck effect.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Split-Path -Parent $PSScriptRoot
$path = Join-Path $source 'windows/install/Recover-HostDeckUserOnce.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Recovery helper PowerShell 5.1 parse failed.' }
foreach ($name in @('Refuse','Assert-Absolute','Assert-NoReparse','Assert-Fields','Sha','ShaBytes',
        'Read-Plan','Assert-OrdinaryUser','Test-Receipt','Wait-Receipt','Assert-ReleaseReceipt',
        'Assert-Entry','Get-InstalledPair','Assert-Service','Get-TrayDecision')) {
    $definitions = @($ast.FindAll({
        param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $false) | Where-Object Name -eq $name)
    if ($definitions.Count -ne 1) { throw ('Required production helper missing: ' + $name) }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$owned = Join-Path $parent ('hostdeck-recovery-owned-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $owned | Out-Null
$passed = 0
function Assert([bool] $ok, [string] $message) { if (-not $ok) { throw $message } }
function Refused([scriptblock] $action, [string] $code) {
    try { & $action | Out-Null; return $false }
    catch { return $_.Exception.Message -ceq ('RECOVERY_' + $code) }
}
function Deadline([int] $minutes) {
    [DateTime]::UtcNow.AddMinutes($minutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}
function Write-Release([string] $root, [string] $version, [string] $sid) {
    $critical = @('tray/HostDeck.Tray.exe','agent/node.exe','agent/dist/hostdeck/main.js',
        'desktop/HostDeck.DesktopWorker.exe','service/HostDeck.Lifecycle.exe')
    $entries = @(
        foreach ($relative in $critical) {
            $file = Join-Path $root ('current\' + $relative.Replace('/', '\'))
            New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
            [IO.File]::WriteAllText($file, 'OWNED FIXTURE ' + $version + ':' + $relative)
            [ordered]@{path=$relative;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
    )
    $manifestPath = Join-Path $root 'current\manifest.json'
    [ordered]@{schema=1;files=$entries} | ConvertTo-Json -Depth 6 |
        Set-Content -LiteralPath $manifestPath -Encoding utf8
    $configPath = Join-Path $root 'config\facade.json'
    New-Item -ItemType Directory -Path (Split-Path -Parent $configPath) -Force | Out-Null
    $worker = Join-Path $root 'current\desktop\HostDeck.DesktopWorker.exe'
    [ordered]@{expected_user_sid=$sid;installed=$true;desktop_worker=$worker;
        desktop_worker_sha256=(Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant()} |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding utf8
    return [pscustomobject]@{
        manifest_sha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant();
        config_sha256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
try {
    $install = Join-Path $owned 'installation'
    New-Item -ItemType Directory -Path $install | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $request = '01234567-89ab-4cde-8123-456789abcdef'
    $goal = '11111111-2222-4333-8444-555555555555'
    $planPath = Join-Path $owned 'plan.json'
    $p = [pscustomobject]@{
        schema=1;enrolled_sid=$sid;session_id=$session;install_root=$install;
        reader_path=(Join-Path $owned 'Read-ClientReceipts.ps1');reader_sha256=('a'*64);
        common_path=(Join-Path $owned 'Bridge.Common.ps1');common_sha256=('b'*64);
        client_id='hostdeck-local';request_id=$request;goal_id=$goal;script_sha256=('c'*64);
        old=[pscustomobject]@{manifest_sha256=('d'*64);config_sha256=('e'*64)};
        new=[pscustomobject]@{manifest_sha256=('f'*64);config_sha256=('1'*64)};
        deadline_utc=(Deadline 20);
        ready_path=(Join-Path $owned ($request+'.ready.json'));
        result_path=(Join-Path $owned ($request+'.result.json'))
    }
    $p | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $planPath -Encoding utf8
    $pin = (Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert ((Read-Plan $planPath $pin).request_id -ceq $request) 'Exact one-read pinned plan.'
    $passed++
    [IO.File]::AppendAllText($planPath, ' ')
    Assert (Refused { Read-Plan $planPath $pin } 'PLAN_HASH') 'Post-pin plan tampering must refuse.'
    $passed++
    $p | Add-Member -NotePropertyName arbitrary_command -NotePropertyValue 'never execute'
    $p | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $planPath -Encoding utf8
    $pin = (Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert (Refused { Read-Plan $planPath $pin } 'PLAN_FIELDS') 'Extra executable fields must refuse.'
    $p.PSObject.Properties.Remove('arbitrary_command')
    $p.deadline_utc = Deadline 35
    $p | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $planPath -Encoding utf8
    $pin = (Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert (Refused { Read-Plan $planPath $pin } 'DEADLINE_INVALID') 'Over 30-minute deadline refused.'
    $passed++
    $p.deadline_utc = Deadline 20
    $p.session_id = $session + 1
    Assert (Refused { Assert-OrdinaryUser $p } 'WRONG_USER_SESSION') 'Wrong session refused.'
    $p.session_id = $session
    $passed++

    $pending = [pscustomobject]@{request_id=$request;status='pending'}
    Assert ((Test-Receipt $pending $p) -ceq 'pending') 'Pending is not terminal.'
    function Read-Receipt { param($plan) return [pscustomobject]@{request_id=$plan.request_id;status='pending'} }
    Assert (Refused { Wait-Receipt $p ([DateTimeOffset]::UtcNow.AddMilliseconds(-1)) } 'REQUEST_PENDING_TIMEOUT') 'Pending deadline must fail, not resume.'
    $passed++
    Assert (Refused { Test-Receipt ([pscustomobject]@{request_id=$request;status='not_found'}) $p } 'REQUEST_NOT_FOUND') 'Unknown request refused.'
    $passed++
    $receipt = [pscustomobject]@{request_id=$request;goal_id=$goal;client_id=$p.client_id;
        script_sha256=$p.script_sha256;status='completed-unverified-effect';
        runner_status='completed';exit_code=0;descendants_contained=$true}
    Assert ((Test-Receipt $receipt $p) -ceq 'terminal') 'Exact terminal receipt required.'
    Assert (Refused { Test-Receipt ([pscustomobject]@{request_id='00000000-0000-4000-8000-000000000000';status='pending'}) $p } 'RECEIPT_IDENTITY') 'Wrong request refused.'
    $receipt.script_sha256 = '0'*64
    Assert (Refused { Test-Receipt $receipt $p } 'RECEIPT_IDENTITY') 'Wrong signed script refused.'
    $receipt.script_sha256 = $p.script_sha256
    $receipt.descendants_contained = $false
    Assert (Refused { Test-Receipt $receipt $p } 'DESCENDANTS_UNQUALIFIED') 'Uncontained child refused.'
    $receipt.descendants_contained = $true
    Assert (Refused { Test-Receipt ([pscustomobject]@{request_id=$request;status='strange'}) $p } 'RECEIPT_UNKNOWN') 'Unknown status refused.'
    $passed++
    Assert (-not (Refused { Assert-ReleaseReceipt 'new' $receipt } 'NEW_RELEASE_NOT_VERIFIED')) 'New exact receipt passes.'
    $receipt.status = 'uncertain-or-failed'
    Assert (Refused { Assert-ReleaseReceipt 'new' $receipt } 'NEW_RELEASE_NOT_VERIFIED') 'Failed new release may not restart.'
    Assert (-not (Refused { Assert-ReleaseReceipt 'old' $receipt } 'NEW_RELEASE_NOT_VERIFIED')) 'Old rollback remains allowed if independently verified.'
    $receipt.status = 'completed-unverified-effect'
    $passed++

    $oldPair = Write-Release $install 'old' $sid
    $newPair = Write-Release $install 'new' $sid
    $null = Write-Release $install 'old' $sid
    $p.old = $oldPair
    $p.new = $newPair
    $installed = Get-InstalledPair $p
    Assert ($installed.choice -ceq 'old') 'Known old package+config matched.'
    $passed++
    [IO.File]::AppendAllText($installed.main, 'TAMPER')
    Assert (Refused { Get-InstalledPair $p } 'RELEASE_FILE_HASH') 'Critical executable tamper refused.'
    $passed++
    $null = Write-Release $install 'new' $sid
    $installed = Get-InstalledPair $p
    Assert ($installed.choice -ceq 'new') 'Known new package+config matched.'
    $passed++
    $originalNewConfigHash = $p.new.config_sha256
    $p.new.config_sha256 = $p.old.config_sha256
    Assert (Refused { Get-InstalledPair $p } 'CURRENT_PAIR_MISMATCH') 'Mixed release/config pair refused.'
    $p.new.config_sha256 = $originalNewConfigHash
    $passed++
    $script:serviceFixture = [pscustomobject]@{State='Running';StartName='NT AUTHORITY\LocalService';
        PathName=('"' + $installed.service + '" --service "' + (Join-Path $install 'service-config.json') + '"')}
    function Get-CimInstance {
        [CmdletBinding()] param([string]$ClassName,[string]$Filter)
        return $script:serviceFixture
    }
    Assert-Service $installed
    $script:serviceFixture.StartName = 'LocalSystem'
    Assert (Refused { Assert-Service $installed } 'SERVICE_UNQUALIFIED') 'Wrong SCM account refused.'
    $passed++

    $argv = '"' + $installed.node + '" "' + $installed.main + '" "' + $installed.config + '"'
    $tray = [pscustomobject]@{name='HostDeck.Tray.exe';pid=3001;session=$session;sid=$sid;
        executable=$installed.tray;command=('"'+$installed.tray+'" '+$argv)}
    $node = [pscustomobject]@{name='node.exe';pid=3002;session=$session;sid=$sid;
        executable=$installed.node;command='owned fixture --http --config'}
    Assert ((Get-TrayDecision $p $installed @()) -ceq 'launch') 'No user processes allows launch.'
    Assert ((Get-TrayDecision $p $installed @($tray)) -ceq 'identical') 'Identical tray does not restart.'
    $passed++
    Assert (Refused { Get-TrayDecision $p $installed @($tray,$tray) } 'DUPLICATE_USER_PROCESS') 'Duplicate tray refused.'
    Assert (Refused { Get-TrayDecision $p $installed @($node) } 'ORPHAN_HTTP_AGENT') 'Orphan agent never stopped or duplicated.'
    $passed++
    $tray.session = $session + 1
    Assert (Refused { Get-TrayDecision $p $installed @($tray) } 'WRONG_PROCESS_SESSION') 'Wrong tray session refused.'
    $tray.session = $session
    $tray.command = 'unrelated arguments'
    Assert (Refused { Get-TrayDecision $p $installed @($tray) } 'OTHER_TRAY_PROCESS') 'Changed tray arguments refused.'
    $passed++
    Write-Output "W2 one-shot recovery owned-plan/receipt/release/process cases: $passed PASS; actual Explorer/SCM/install NOT_RUN."
} finally {
    $resolved = [IO.Path]::GetFullPath($owned)
    if ((Split-Path -Parent $resolved).TrimEnd('\') -cne $parent -or
        (Split-Path -Leaf $resolved) -notmatch '^hostdeck-recovery-owned-[a-f0-9]{32}$') {
        throw 'Unsafe fixture cleanup.'
    }
    foreach ($item in @((Get-Item -LiteralPath $resolved -Force)) +
            @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Owned fixture contains a reparse point; no deletion.'
        }
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
