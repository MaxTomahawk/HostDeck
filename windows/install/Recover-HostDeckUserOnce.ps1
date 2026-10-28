# One-shot enrolled-user continuation for a previously submitted, GO-gated
# HostDeck install request. Never submits, retries, stops or elevates anything.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $PlanPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string] $PlanSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Refuse([string] $reason) { throw ('RECOVERY_' + $reason) }
function Assert-Absolute([string] $path) {
    if (-not [IO.Path]::IsPathRooted($path) -or $path -match '["\x00-\x1f]' -or
        [IO.Path]::GetFullPath($path) -cne $path) { Refuse 'PATH_INVALID' }
}
function Assert-NoReparse([string] $path) {
    Assert-Absolute $path
    $part = $path
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'REPARSE_PATH' }
        }
        $parent = Split-Path -Parent $part
        if (-not $parent -or $parent -eq $part) { break }
        $part = $parent
    }
}
function Assert-Fields($value, [string[]] $fields) {
    if ($null -eq $value -or $value -isnot [pscustomobject]) { Refuse 'PLAN_FIELDS' }
    $actual = @($value.PSObject.Properties.Name)
    if ($actual.Count -ne $fields.Count) { Refuse 'PLAN_FIELDS' }
    foreach ($key in $fields) { if ($key -cnotin $actual) { Refuse 'PLAN_FIELDS' } }
}
function Sha([string] $path) {
    Assert-NoReparse $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Refuse 'FILE_MISSING' }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function ShaBytes([byte[]] $bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Read-Plan([string] $path, [string] $expectedSha) {
    Assert-NoReparse $path
    $bytes = [IO.File]::ReadAllBytes($path) # exactly one plan read
    if ($bytes.Length -lt 100 -or $bytes.Length -gt 16384 -or (ShaBytes $bytes) -cne $expectedSha) {
        Refuse 'PLAN_HASH'
    }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff)
    $p = $text | ConvertFrom-Json -ErrorAction Stop
    Assert-Fields $p @('schema','enrolled_sid','session_id','install_root','reader_path',
        'reader_sha256','common_path','common_sha256','client_id','request_id','goal_id',
        'script_sha256','old','new','deadline_utc','ready_path','result_path')
    foreach ($pair in @($p.old, $p.new)) {
        Assert-Fields $pair @('manifest_sha256','config_sha256')
        foreach ($property in @('manifest_sha256','config_sha256')) {
            if ([string]$pair.$property -cnotmatch '^[a-f0-9]{64}$') { Refuse 'PLAN_HASH' }
        }
    }
    if ($p.schema -ne 1 -or [string]$p.enrolled_sid -notmatch '^S-1-5-(?:\d+-)+\d+$' -or
        ($p.session_id -isnot [int] -and $p.session_id -isnot [long]) -or
        $p.session_id -le 0 -or $p.session_id -gt [int]::MaxValue -or
        [string]$p.client_id -cnotmatch '^[a-z][a-z0-9-]{2,39}$' -or
        [string]$p.request_id -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' -or
        [string]$p.goal_id -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' -or
        [string]$p.script_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        [string]$p.reader_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        [string]$p.common_sha256 -cnotmatch '^[a-f0-9]{64}$') { Refuse 'PLAN_FIELDS' }
    if ($p.old.manifest_sha256 -ceq $p.new.manifest_sha256 -and
        $p.old.config_sha256 -ceq $p.new.config_sha256) { Refuse 'AMBIGUOUS_RELEASE_PAIR' }
    if ([string]$p.deadline_utc -notmatch 'Z$') { Refuse 'DEADLINE_INVALID' }
    $deadline = [DateTimeOffset]::Parse([string]$p.deadline_utc, [Globalization.CultureInfo]::InvariantCulture)
    $now = [DateTimeOffset]::UtcNow
    if ($deadline -le $now -or $deadline -gt $now.AddMinutes(30)) { Refuse 'DEADLINE_INVALID' }
    foreach ($name in @('install_root','reader_path','common_path','ready_path','result_path')) {
        Assert-NoReparse ([string]$p.$name)
    }
    $directory = Split-Path -Parent $path
    if ([string]$p.ready_path -cne (Join-Path $directory ($p.request_id + '.ready.json')) -or
        [string]$p.result_path -cne (Join-Path $directory ($p.request_id + '.result.json')) -or
        [string]$p.install_root -ieq $directory -or
        $directory.StartsWith(([string]$p.install_root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Refuse 'PLAN_OUTPUT_SCOPE'
    }
    if ((Test-Path -LiteralPath $p.ready_path) -or (Test-Path -LiteralPath $p.result_path)) {
        Refuse 'RECOVERY_ALREADY_STARTED'
    }
    return $p
}
function Assert-OrdinaryUser($p) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ceq 'S-1-5-18' -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'ELEVATED_OR_SYSTEM' }
    if ($identity.User.Value -cne [string]$p.enrolled_sid -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -ne [int]$p.session_id) {
        Refuse 'WRONG_USER_SESSION'
    }
}
function Assert-ProtectedFile([string] $path, [bool] $allowInherited = $false) {
    Assert-NoReparse $path
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ((-not $allowInherited -and -not $acl.AreAccessRulesProtected) -or
        $owner -notin @('S-1-5-18','S-1-5-32-544')) {
        Refuse 'READER_ACL'
    }
    $writeMask = 0x00000002 -bor 0x00000004 -bor 0x00000010 -bor 0x00000040 -bor
        0x00000100 -bor 0x00010000 -bor 0x00040000 -bor 0x00080000 -bor
        0x40000000 -bor 0x10000000
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            (($ace.FileSystemRights -band $writeMask) -ne 0 -and
             $ace.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544'))) {
            Refuse 'READER_ACL'
        }
    }
}
function Assert-ReceiptReader($p) {
    $base = Join-Path $env:ProgramData 'CodexMandateBridge'
    $public = Join-Path $base 'public'
    if (-not [string]::Equals($p.reader_path, (Join-Path $public 'Read-ClientReceipts.ps1'),
            [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($p.common_path, (Join-Path $public 'Bridge.Common.ps1'),
            [StringComparison]::OrdinalIgnoreCase)) { Refuse 'READER_LOCATION' }
    foreach ($path in @($base, $public, $p.reader_path, $p.common_path,
            (Join-Path $base 'outbox'), (Join-Path $base ('outbox\' + $p.client_id)))) {
        Assert-ProtectedFile $path
    }
    $receiptPath = Join-Path $base ('outbox\' + $p.client_id + '\' + $p.request_id + '.result.json')
    # Broker-created receipt files inherit their protected outbox DACL.
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) { Assert-ProtectedFile $receiptPath $true }
    if ((Sha $p.reader_path) -cne $p.reader_sha256 -or
        (Sha $p.common_path) -cne $p.common_sha256) { Refuse 'READER_HASH' }
}
function Read-Receipt($p) {
    Assert-ReceiptReader $p
    $items = @(& $p.reader_path -ClientId $p.client_id -RequestId $p.request_id)
    if ($items.Count -ne 1 -or $null -eq $items[0]) { Refuse 'RECEIPT_UNQUALIFIED' }
    return $items[0]
}
function Test-Receipt($receipt, $p) {
    if ([string]$receipt.request_id -cne [string]$p.request_id) { Refuse 'RECEIPT_IDENTITY' }
    if ([string]$receipt.status -ceq 'pending') { return 'pending' }
    if ([string]$receipt.status -ceq 'not_found') { Refuse 'REQUEST_NOT_FOUND' }
    if ([string]$receipt.status -cnotin @('completed-unverified-effect','uncertain-or-failed','timed_out',
            'denied-or-preexecution-failure')) { Refuse 'RECEIPT_UNKNOWN' }
    if ([string]$receipt.client_id -cne [string]$p.client_id -or
        [string]$receipt.goal_id -cne [string]$p.goal_id -or
        [string]$receipt.script_sha256 -cne [string]$p.script_sha256) { Refuse 'RECEIPT_IDENTITY' }
    if ($receipt.descendants_contained -isnot [bool] -or $receipt.descendants_contained -ne $true) {
        Refuse 'DESCENDANTS_UNQUALIFIED'
    }
    return 'terminal'
}
function Assert-ReleaseReceipt([string] $choice, $receipt) {
    # An unchanged, fully verified old release may be restored after a
    # contained failure; never label that failure an installed success.
    if ($choice -ceq 'new' -and
        ($receipt.status -cne 'completed-unverified-effect' -or
         $receipt.runner_status -cne 'completed' -or $receipt.exit_code -ne 0)) {
        Refuse 'NEW_RELEASE_NOT_VERIFIED'
    }
}
function Wait-Receipt($p, [DateTimeOffset] $deadline) {
    do {
        $receipt = Read-Receipt $p
        if ((Test-Receipt $receipt $p) -ceq 'terminal') { return $receipt }
        Start-Sleep -Seconds 2 # bounded wait for one exact ID, never a persistent poller
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    Refuse 'REQUEST_PENDING_TIMEOUT'
}
function Assert-Entry($manifest, [string] $root, [string] $relative) {
    $items = @($manifest.files | Where-Object { [string]$_.path -ieq $relative })
    if ($items.Count -ne 1 -or [string]$items[0].path -cne $relative -or
        [string]$items[0].sha256 -cnotmatch '^[a-fA-F0-9]{64}$') { Refuse 'MANIFEST_ENTRY' }
    $file = Join-Path $root ('current\' + $relative.Replace('/', '\'))
    if ((Sha $file) -cne ([string]$items[0].sha256).ToLowerInvariant()) { Refuse 'RELEASE_FILE_HASH' }
    return $file
}
function Get-InstalledPair($p) {
    $root = [string]$p.install_root
    $manifestPath = Join-Path $root 'current\manifest.json'
    $configPath = Join-Path $root 'config\facade.json'
    Assert-NoReparse $manifestPath
    Assert-NoReparse $configPath
    # The exact bytes used for the hash are also the bytes parsed below.
    $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
    $configBytes = [IO.File]::ReadAllBytes($configPath)
    $manifestHash = ShaBytes $manifestBytes
    $configHash = ShaBytes $configBytes
    $choice = ''
    if ($manifestHash -ceq $p.old.manifest_sha256 -and $configHash -ceq $p.old.config_sha256) {
        $choice = 'old'
    } elseif ($manifestHash -ceq $p.new.manifest_sha256 -and $configHash -ceq $p.new.config_sha256) {
        $choice = 'new'
    } else { Refuse 'CURRENT_PAIR_MISMATCH' }
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $manifest = $utf8.GetString($manifestBytes).TrimStart([char]0xfeff) | ConvertFrom-Json -ErrorAction Stop
    $config = $utf8.GetString($configBytes).TrimStart([char]0xfeff) | ConvertFrom-Json -ErrorAction Stop
    if ($manifest.schema -ne 1 -or -not $manifest.files -or
        [string]$config.expected_user_sid -cne [string]$p.enrolled_sid -or
        $config.installed -ne $true) { Refuse 'CURRENT_CONFIG_INVALID' }
    $paths = @{}
    foreach ($item in @('tray/HostDeck.Tray.exe','agent/node.exe',
            'agent/dist/hostdeck/main.js','desktop/HostDeck.DesktopWorker.exe',
            'service/HostDeck.Lifecycle.exe')) {
        $paths[$item] = Assert-Entry $manifest $root $item
    }
    $worker = $paths['desktop/HostDeck.DesktopWorker.exe']
    if (-not [string]::Equals([string]$config.desktop_worker, $worker,
            [StringComparison]::OrdinalIgnoreCase) -or
        [string]$config.desktop_worker_sha256 -cne (Sha $worker)) {
        Refuse 'WORKER_CONFIG_PIN'
    }
    return [pscustomobject]@{choice=$choice;root=$root;config=$configPath;
        tray=$paths['tray/HostDeck.Tray.exe'];node=$paths['agent/node.exe'];
        main=$paths['agent/dist/hostdeck/main.js'];
        service=$paths['service/HostDeck.Lifecycle.exe']}
}
function Assert-Service($installed) {
    $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='HostDeck'" -ErrorAction Stop
    $expected = '"' + $installed.service + '" --service "' + (Join-Path $installed.root 'service-config.json') + '"'
    if ($null -eq $service -or $service.State -cne 'Running' -or
        $service.StartName -cne 'NT AUTHORITY\LocalService' -or
        -not [string]::Equals($service.PathName, $expected, [StringComparison]::OrdinalIgnoreCase)) {
        Refuse 'SERVICE_UNQUALIFIED'
    }
}
function Get-UserProcesses($installed) {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='HostDeck.Tray.exe' OR Name='node.exe'" -ErrorAction Stop)
    $result = @()
    foreach ($p in $procs) {
        $isTray = [string]$p.Name -ieq 'HostDeck.Tray.exe'
        $command = [string]$p.CommandLine
        $exe = [string]$p.ExecutablePath
        $isRelevantNode = -not $isTray -and (
            $exe.StartsWith($installed.root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $command.IndexOf($installed.config, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        if (-not $isTray -and -not $isRelevantNode) { continue }
        $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop
        if ($owner.ReturnValue -ne 0) { Refuse 'PROCESS_OWNER_UNAVAILABLE' }
        $result += [pscustomobject]@{name=[string]$p.Name;pid=[int]$p.ProcessId;
            session=[int]$p.SessionId;sid=[string]$owner.Sid;
            executable=$exe;command=$command}
    }
    return $result
}
function Get-TrayDecision($p, $installed, [object[]] $processes) {
    $trays = @($processes | Where-Object { $_.name -ieq 'HostDeck.Tray.exe' })
    $nodes = @($processes | Where-Object { $_.name -ieq 'node.exe' })
    if ($trays.Count -gt 1 -or $nodes.Count -gt 1) { Refuse 'DUPLICATE_USER_PROCESS' }
    foreach ($process in @($trays) + @($nodes)) {
        if ($process.session -ne $p.session_id -or $process.sid -cne $p.enrolled_sid) {
            Refuse 'WRONG_PROCESS_SESSION'
        }
    }
    if ($trays.Count -eq 0) {
        if ($nodes.Count -ne 0) { Refuse 'ORPHAN_HTTP_AGENT' }
        return 'launch'
    }
    $arguments = '"' + $installed.node + '" "' + $installed.main + '" "' + $installed.config + '"'
    $cmd = [string]$trays[0].command
    if (-not [string]::Equals([string]$trays[0].executable, $installed.tray,
            [StringComparison]::OrdinalIgnoreCase) -or
        ($cmd -ine ('"' + $installed.tray + '" ' + $arguments) -and
         $cmd -ine ($installed.tray + ' ' + $arguments))) { Refuse 'OTHER_TRAY_PROCESS' }
    return 'identical'
}
function Write-Once([string] $path, $value) {
    Assert-NoReparse $path
    $tmp = $path + '.part-' + [guid]::NewGuid().ToString('N')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $value -Compress -Depth 5) + [Environment]::NewLine)
    try {
        $stream = [IO.FileStream]::new($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Move($tmp, $path) # atomic new file; never overwrite previous result
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    }
}
function Run-Once($p, [string] $planSha) {
    Assert-OrdinaryUser $p
    Assert-ReceiptReader $p
    $start = Get-InstalledPair $p
    if ($start.choice -cne 'old') { Refuse 'INITIAL_RELEASE_NOT_OLD' }
    Assert-Service $start
    if ([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse([string]$p.deadline_utc,
            [Globalization.CultureInfo]::InvariantCulture)) { Refuse 'DEADLINE_EXPIRED' }
    $pidValue = [Diagnostics.Process]::GetCurrentProcess().Id
    Write-Once $p.ready_path ([ordered]@{schema=1;request_id=$p.request_id;plan_sha256=$planSha;
        helper_pid=$pidValue;session_id=$p.session_id;started_utc=[DateTimeOffset]::UtcNow.ToString('o');
        deadline_utc=$p.deadline_utc;status='ready'})
    $receipt = Wait-Receipt $p ([DateTimeOffset]::Parse([string]$p.deadline_utc,
        [Globalization.CultureInfo]::InvariantCulture))
    $installed = Get-InstalledPair $p
    Assert-Service $installed
    Assert-ReleaseReceipt $installed.choice $receipt
    $decision = Get-TrayDecision $p $installed @(Get-UserProcesses $installed)
    $trayPid = $null
    if ($decision -ceq 'launch') {
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $installed.tray
        $info.Arguments = '"' + $installed.node + '" "' + $installed.main + '" "' + $installed.config + '"'
        $info.WorkingDirectory = Split-Path -Parent $installed.tray
        $info.UseShellExecute = $true # under this same ordinary logged-in user, no elevation
        $started = [Diagnostics.Process]::Start($info)
        if ($null -eq $started) { Refuse 'TRAY_START_FAILED' }
        try { $trayPid = $started.Id } finally { $started.Dispose() }
        Start-Sleep -Milliseconds 500
        $observed = @(Get-UserProcesses $installed)
        if ((Get-TrayDecision $p $installed $observed) -cne 'identical' -or
            @($observed | Where-Object { $_.name -ieq 'HostDeck.Tray.exe' -and $_.pid -eq $trayPid }).Count -ne 1) {
            Refuse 'TRAY_START_UNQUALIFIED'
        }
    } else {
        $trayPid = @((Get-UserProcesses $installed) | Where-Object { $_.name -ieq 'HostDeck.Tray.exe' })[0].pid
    }
    return [pscustomobject]@{outcome=$(if ($installed.choice -ceq 'new') {'new_restored'} else {'old_restored'});
        release=$installed.choice;receipt_status=[string]$receipt.status;tray_action=$decision;tray_pid=$trayPid}
}

$plan = $null
$pidValue = [Diagnostics.Process]::GetCurrentProcess().Id
$sessionValue = [Diagnostics.Process]::GetCurrentProcess().SessionId
try {
    $plan = Read-Plan $PlanPath $PlanSha256
    $outcome = Run-Once $plan $PlanSha256
    Write-Once $plan.result_path ([ordered]@{schema=1;request_id=$plan.request_id;helper_pid=$pidValue;
        session_id=$sessionValue;exit_code=0;outcome=$outcome.outcome;release=$outcome.release;
        receipt_status=$outcome.receipt_status;tray_action=$outcome.tray_action;tray_pid=$outcome.tray_pid;
        finished_utc=[DateTimeOffset]::UtcNow.ToString('o')})
    exit 0
} catch {
    $reason = if ($_.Exception.Message -cmatch '^RECOVERY_[A-Z0-9_]+$') { $_.Exception.Message }
        else { 'RECOVERY_UNQUALIFIED' }
    if ($null -ne $plan -and -not (Test-Path -LiteralPath $plan.result_path)) {
        try {
            Write-Once $plan.result_path ([ordered]@{schema=1;request_id=$plan.request_id;
                helper_pid=$pidValue;session_id=$sessionValue;exit_code=1;outcome='refused';
                reason=$reason;finished_utc=[DateTimeOffset]::UtcNow.ToString('o')})
        } catch { }
    }
    Write-Output $reason
    exit 1
}
