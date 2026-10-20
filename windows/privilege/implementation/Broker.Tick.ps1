# Scheduled SYSTEM entrypoint. The runner and all elevated code live under admin/SYSTEM-only ACLs.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-System
$settings=Read-Settings
if (-not $settings.enabled) { return }
$trust=Read-Trust
$runner=Join-Path $script:BridgeRoot 'bin\PrivilegedJobRunner.exe'
Assert-FileSha $runner ([string]$settings.runner_sha256)
Assert-FileSha (Join-Path $script:BridgeRoot 'trust\owner.cer') ([string]$settings.owner_cert_sha256)
$lockPath=Join-Path $script:BridgeRoot 'work\tick.lock'
try {$lock=[IO.FileStream]::new($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
catch [IO.IOException] {return}
try {
  # Signed post-execution verification reports are append-only, not elevated actions.
  & (Join-Path $PSScriptRoot 'Broker.Verify.ps1')
  # A crash after reservation but before intent cannot have launched an effect.
  # Close that request explicitly; never leave it silently skipped forever.
  foreach($reservation in @(Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'state') -Filter '*.reserved' -File)) {
    if($reservation.Name -like '*.verify.reserved'){continue}
    $reservedId=$reservation.Name.Substring(0,$reservation.Name.Length-'.reserved'.Length)
    if(-not(Test-IsUuid $reservedId)){throw 'INVALID_RESERVED_REQUEST_ID'}
    $intentPath=Join-Path $script:BridgeRoot ('audit\'+$reservedId+'.intent.json')
    if(Test-Path -LiteralPath $intentPath){continue}
    $resultPath=Join-Path $script:BridgeRoot ('audit\'+$reservedId+'.result.json')
    if(Test-Path -LiteralPath $resultPath){throw 'RESULT_WITHOUT_INTENT_RECOVERY_REQUIRED'}
    $recovery=[ordered]@{schema=1;request_id=$reservedId;status='denied-or-preexecution-failure';
      error_code='RESERVATION_WITHOUT_INTENT_AFTER_INTERRUPTION';effect_verified=$false;
      runner_status='not-started';started_utc=[DateTimeOffset]::UtcNow.ToString('o');
      finished_utc=[DateTimeOffset]::UtcNow.ToString('o')}
    Write-JsonNew $intentPath ([ordered]@{schema=1;request_id=$reservedId;
      received_utc=[DateTimeOffset]::UtcNow.ToString('o');action='recovered-preexecution-reservation';
      outcome='denied-without-effect'})
    Write-JsonNew $resultPath $recovery
    $candidate=@(Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'inbox') -Filter ($reservedId+'.request.json') -File -Recurse)
    if($candidate.Count -eq 1){
      $mailbox=Split-Path -Leaf (Split-Path -Parent $candidate[0].FullName)
      if($mailbox -match '^[a-z][a-z0-9-]{2,39}$' -and (Test-Path -LiteralPath (Join-Path $script:BridgeRoot ('outbox\'+$mailbox)))){
        Write-JsonNew (Join-Path $script:BridgeRoot ('outbox\'+$mailbox+'\'+$reservedId+'.result.json')) $recovery
      }
    }
    Write-Output ('PREEXECUTION_RECOVERED_DENIED: '+$reservedId)
  }
  # Never silently replay a request after interruption. An unresolved intent is a safe-stop checkpoint.
  foreach($intent in @(Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'audit') -Filter '*.intent.json' -File)) {
    $base=$intent.Name.Substring(0,$intent.Name.Length-'.intent.json'.Length)
    if(-not [IO.File]::Exists((Join-Path $script:BridgeRoot ('audit\'+$base+'.result.json')))) {
      Write-Output ('RECOVERY_REQUIRED: unresolved intent '+$base); return
    }
  }
  $queued=@(Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'inbox') -Filter '*.request.json' -File -Recurse |
    Where-Object {
      $candidateId=$_.Name.Substring(0,$_.Name.Length-'.request.json'.Length)
      (Test-IsUuid $candidateId) -and
        (-not [IO.File]::Exists((Join-Path $script:BridgeRoot ('audit\'+$candidateId+'.intent.json'))))
    } | Sort-Object CreationTimeUtc)
  foreach($file in ($queued | Select-Object -First 10)) {
    $identifier=$file.Name.Substring(0,$file.Name.Length-'.request.json'.Length)
    if(-not (Test-IsUuid $identifier)) {continue}
    if([IO.File]::Exists((Join-Path $script:BridgeRoot ('audit\'+$identifier+'.intent.json')))) {continue}
    $reserved=Join-Path $script:BridgeRoot ('state\'+$identifier+'.reserved')
    try {
      $handle=[IO.File]::Open($reserved,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $handle.Dispose()
    } catch [IO.IOException] {continue}
    $mailbox=Split-Path -Leaf (Split-Path -Parent $file.FullName)
    $started=[DateTimeOffset]::UtcNow
    $effectStarted=$false
    $result=[ordered]@{schema=1;request_id=$identifier;goal_id='';client_id='';retry_of='';goal='';mandate_evidence='';effect_verified=$false;
      mandate_validation='not-machine-verifiable';risk='';script_sha256='';action_summary='';expected_change='';
      observed_change='unmeasured';project_id='';chat_id='';authenticated_client_cert_sha256='';
      asserted_origin_sid='not-observable-from-queue';authenticated_windows_runner_sid='S-1-5-18';
      started_utc=$started.ToString('o');finished_utc='';exit_code=$null;stdout_sha256='';stderr_sha256='';
      status='denied';error_code='';runner_status='not-started';descendants_contained=$null}
    $intent=[ordered]@{schema=1;request_id=$identifier;received_utc=$started.ToString('o');
      raw_envelope_sha256='';signed_payload_sha256='';raw_command_sha256='';
      client_id='unverified';goal='unverified';risk='unverified';action='unverified';outcome='reservation'}
    try {
      Assert-NoReparse $file.FullName
      if($file.Length -lt 100 -or $file.Length -gt 1600000){throw 'REQUEST_FILE_SIZE_INVALID'}
      $raw=[IO.File]::ReadAllBytes($file.FullName)
      $intent.raw_envelope_sha256=Get-Sha256 $raw
      $envelope=$script:Utf8.GetString($raw)|ConvertFrom-Json -ErrorAction Stop
      if($envelope.schema -ne 1 -or -not $envelope.payload_base64){throw 'INVALID_ENVELOPE'}
      $rough=$script:Utf8.GetString([Convert]::FromBase64String([string]$envelope.payload_base64))|ConvertFrom-Json -ErrorAction Stop
      if($rough.client_id -notmatch '^[a-z][a-z0-9-]{2,39}$'){throw 'INVALID_CLIENT_ID'}
      $entry=@($trust.clients|Where-Object{$_.client_id -ceq $rough.client_id})
      if($entry.Count -ne 1 -or -not $entry[0].enabled){throw 'CLIENT_NOT_ENROLLED'}
      $certFile=Join-Path $script:BridgeRoot ('trust\'+$rough.client_id+'.cer')
      Assert-FileSha $certFile ([string]$entry[0].certificate_sha256)
      $checked=Get-SignedPayloadBytes $raw $certFile
      if($checked.CertSha256 -cne [string]$entry[0].certificate_sha256){throw 'CLIENT_CERT_CHANGED'}
      $p=$checked.Data
      Assert-Props $p @('schema','request_id','created_unix_ms','client_id','goal_id','goal','mandate_evidence',
        'mandate_attestation','risk','action_summary','expected_change','project_id','chat_id','retry_of',
        'timeout_seconds','script_base64','script_sha256','owner_approval_base64')
      if($p.schema -ne 1 -or $p.request_id -cne $identifier -or $p.client_id -cne $rough.client_id -or
        (Split-Path -Leaf (Split-Path -Parent $file.FullName)) -cne [string]$p.client_id -or
        -not (Test-IsUuid ([string]$p.goal_id)) -or ($p.retry_of -and -not (Test-IsUuid ([string]$p.retry_of)))){throw 'REQUEST_ID_OR_SCHEMA_INVALID'}
      $when=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.created_unix_ms)
      if($when -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $when -lt [DateTimeOffset]::UtcNow.AddMinutes(-12)) {throw 'REQUEST_EXPIRED'}
      if([string]$p.goal -notmatch '^.{8,2000}$' -or [string]$p.action_summary -notmatch '^.{8,1000}$' -or
        [string]$p.expected_change -notmatch '^.{8,1000}$' -or
        [string]$p.mandate_evidence -notmatch '^.{8,1000}$' -or
        [string]$p.mandate_attestation -cne 'client-assessed-not-owner-cryptographically-verified') {throw 'MANDATE_METADATA_INVALID'}
      if($p.risk -cnotin @('standard','elevated-risk','critical')){throw 'RISK_INVALID'}
      if($p.retry_of){
        $parentPath=Join-Path $script:BridgeRoot ('audit\'+[string]$p.retry_of+'.result.json')
        if(-not(Test-Path -LiteralPath $parentPath -PathType Leaf)){throw 'RETRY_PARENT_NOT_FINAL'}
        $parent=Read-JsonFile $parentPath 1048576
        if([string]$parent.goal_id -cne [string]$p.goal_id -or [string]$parent.client_id -cne [string]$p.client_id){throw 'RETRY_SCOPE_MISMATCH'}
        if([string]$parent.status -in @('completed-unverified-effect','verified-completed')){throw 'RETRY_OF_COMPLETED_REQUEST_DENIED'}
      }
      if([int]$p.timeout_seconds -lt 10 -or [int]$p.timeout_seconds -gt 900){throw 'TIMEOUT_INVALID'}
      $scriptBytes=[Convert]::FromBase64String([string]$p.script_base64)
      if($scriptBytes.Length -lt 1 -or $scriptBytes.Length -gt 131072 -or
        (Get-Sha256 $scriptBytes) -cne [string]$p.script_sha256){throw 'SCRIPT_CONTENT_INVALID'}
      if($p.risk -ceq 'critical') {
        if(-not $p.owner_approval_base64){throw 'OWNER_APPROVAL_REQUIRED'}
        $approvalBytes=[Convert]::FromBase64String([string]$p.owner_approval_base64)
        if($approvalBytes.Length -gt 65536){throw 'OWNER_APPROVAL_OVERSIZED'}
        $approvalPath=Join-Path $script:BridgeRoot ('work\'+$identifier+'.approval.json')
        $s=[IO.File]::Open($approvalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$s.Write($approvalBytes,0,$approvalBytes.Length)}finally{$s.Dispose()}
        $grant=Get-SignedPayload $approvalPath (Join-Path $script:BridgeRoot 'trust\owner.cer') 32768
        $g=$grant.Data
        if($g.schema -ne 1 -or $g.goal_id -cne $p.goal_id -or $g.client_id -cne $p.client_id -or
          $g.risk_ceiling -cne 'critical' -or [string]$g.goal_sha256 -cne (Get-Sha256 ($script:Utf8.GetBytes([string]$p.goal))) -or
          [DateTimeOffset]::FromUnixTimeMilliseconds([long]$g.expires_unix_ms) -lt [DateTimeOffset]::UtcNow){throw 'OWNER_APPROVAL_SCOPE_INVALID'}
      }
      $result.goal_id=[string]$p.goal_id;$result.client_id=[string]$p.client_id
      $result.retry_of=[string]$p.retry_of;$result.goal=Remove-Secrets ([string]$p.goal) 2000
      $result.mandate_evidence=Remove-Secrets ([string]$p.mandate_evidence) 1000
      $result.risk=[string]$p.risk;$result.action_summary=Remove-Secrets ([string]$p.action_summary) 1000
      $result.expected_change=Remove-Secrets ([string]$p.expected_change) 1000
      $result.project_id=[string]$p.project_id;$result.chat_id=[string]$p.chat_id
      $result.script_sha256=[string]$p.script_sha256
      $result.authenticated_client_cert_sha256=$checked.CertSha256
      $intent.signed_payload_sha256=$checked.PayloadSha256
      $intent.raw_command_sha256=[string]$p.script_sha256;$intent.client_id=[string]$p.client_id
      $intent.goal=$result.goal;$intent.risk=$result.risk;$intent.action='powershell-script-under-SYSTEM'
      $intent.goal_id=$result.goal_id;$intent.retry_of=$result.retry_of
      $intent.mandate_evidence=$result.mandate_evidence
      $intent.mandate_validation='client-claimed-standing-delegation'
      $intent.action_summary=$result.action_summary
      $intent.expected_change=$result.expected_change
      $intent.project_id=$result.project_id;$intent.chat_id=$result.chat_id
      $intent.client_certificate_sha256=$checked.CertSha256
      $intent.script_sha256=$result.script_sha256
      $intent.owner_goal_approval=($p.risk -ceq 'critical')
      $intent.action_timeout_seconds=[int]$p.timeout_seconds
      # Audit is a precondition, not a best-effort afterthought.
      Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$identifier+'.intent.json')) $intent
      $workDir=Join-Path $script:BridgeRoot ('work\'+$identifier)
      New-Item -ItemType Directory -Path $workDir -ErrorAction Stop | Out-Null
      Set-ExactAcl $workDir
      $scriptFile=Join-Path $workDir 'action.ps1'
      [IO.File]::WriteAllBytes($scriptFile,$scriptBytes)
      Set-ExactAcl $scriptFile
      Assert-FileSha $scriptFile ([string]$p.script_sha256)
      $before=@(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Sort-Object Name |
        ForEach-Object {([string]$_.Name)+':'+([string]$_.State)}) -join "`n"
      $result.before_service_state_sha256=Get-Sha256 ($script:Utf8.GetBytes($before))
      $jobId=$identifier.Replace('-','')
      $jobDir=Join-Path $script:BridgeRoot 'work\jobs'
      $jobFile=Join-Path $jobDir ($jobId+'.request.json')
      $job=[ordered]@{schema=1;job_id=$jobId;script_path=$scriptFile;timeout_seconds=[int]$p.timeout_seconds}
      Write-JsonNew $jobFile $job
      Assert-FileSha $runner ([string]$settings.runner_sha256)
      # Only protected filenames generated by this broker go to the native Job Object runner.
      $effectStarted=$true
      & $runner $jobFile | Out-Null
      $jobReceipt=Join-Path $jobDir ($jobId+'.result.json')
      if(-not (Test-Path -LiteralPath $jobReceipt)){throw 'MISSING_NATIVE_JOB_RECEIPT_UNCERTAIN'}
      $native=Read-JsonFile $jobReceipt 32768
      $result.runner_status=[string]$native.status
      $result.descendants_contained=$native.descendants_contained
      $result.exit_code=$native.exit_code
      $stdout=Join-Path $jobDir ($jobId+'.out');$stderr=Join-Path $jobDir ($jobId+'.err')
      if(Test-Path -LiteralPath $stdout){$result.stdout_sha256=Get-FileSha $stdout}
      if(Test-Path -LiteralPath $stderr){$result.stderr_sha256=Get-FileSha $stderr}
      $after=@(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Sort-Object Name |
        ForEach-Object {([string]$_.Name)+':'+([string]$_.State)}) -join "`n"
      $result.after_service_state_sha256=Get-Sha256 ($script:Utf8.GetBytes($after))
      $result.observed_change='service-state-fingerprint '+$result.before_service_state_sha256+' -> '+$result.after_service_state_sha256+
        '; other system changes NOT INFERRED from exit code; agent must perform separate targeted verification'
      $result.effect_verified=$false
      $result.status=if($native.status -ceq 'completed' -and $native.exit_code -eq 0 -and $native.descendants_contained){'completed-unverified-effect'}
        elseif($native.status -ceq 'timed_out'){'timed_out'} else {'uncertain-or-failed'}
      $result.error_code=if($result.status -ceq 'completed-unverified-effect'){''}else{[string]$native.status}
    }catch{
      $result.error_code=Remove-Secrets ([string]$_.Exception.Message) 250
      if($effectStarted -or $result.runner_status -ne 'not-started') {$result.status='uncertain-or-failed'}
      else {$result.status='denied-or-preexecution-failure'}
      $pre=Join-Path $script:BridgeRoot ('audit\'+$identifier+'.intent.json')
      if(-not (Test-Path -LiteralPath $pre)) {
        $intent.action='denied-before-execution'
        Write-JsonNew $pre $intent
      }
    }finally {
      $result.finished_utc=[DateTimeOffset]::UtcNow.ToString('o')
      $result.finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $result.duration_ms=[long](([DateTimeOffset]::UtcNow-$started).TotalMilliseconds)
      # Any failure writing result HALTS broker by leaving unresolved intent. Never claim success silently.
      $auditResult=Join-Path $script:BridgeRoot ('audit\'+$identifier+'.result.json')
      Write-JsonNew $auditResult $result
      Write-JsonNew (Join-Path $script:BridgeRoot ('outbox\'+$mailbox+'\'+$identifier+'.result.json')) $result
    }
    # Conservative scheduling: one audited execution per tick, no overlapping privileged work.
    break
  }
}finally {$lock.Dispose()}
