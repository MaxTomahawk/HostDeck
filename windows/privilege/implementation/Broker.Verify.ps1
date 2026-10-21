# Invoked only from the privileged SYSTEM tick. Signed, append-only client verification report.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-System
$trust=Read-Trust
foreach($file in @(Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'inbox') -Filter '*.verify.json' -Recurse -File | Sort-Object CreationTimeUtc | Select-Object -First 10)) {
 $verificationId=$file.Name.Substring(0,$file.Name.Length-'.verify.json'.Length)
 if(-not(Test-IsUuid $verificationId)){continue}
 $reserved=Join-Path $script:BridgeRoot ('state\'+$verificationId+'.verify.reserved')
 try {$guard=[IO.File]::Open($reserved,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$guard.Dispose()}
 catch [IO.IOException] {continue}
 $mailbox=Split-Path -Leaf (Split-Path -Parent $file.FullName)
 $message=[ordered]@{schema=1;verification_id=$verificationId;for_request_id='';client_id='';
  status='denied';reason='';received_utc=[DateTimeOffset]::UtcNow.ToString('o')}
 try {
  if($file.Length -lt 100 -or $file.Length -gt 32000){throw 'VERIFICATION_OVERSIZE'}
  Assert-NoReparse $file.FullName
  $envelopeBytes=[IO.File]::ReadAllBytes($file.FullName)
  if($envelopeBytes.Length -lt 2 -or $envelopeBytes.Length -gt 32000){throw 'VERIFICATION_OVERSIZE'}
  $rough=($script:Utf8.GetString($envelopeBytes)|ConvertFrom-Json -ErrorAction Stop).payload_base64
  if(-not $rough){throw 'INVALID_ENVELOPE'}
  $raw=[Convert]::FromBase64String([string]$rough)
  if($raw.Length -gt 8192){throw 'VERIFICATION_PAYLOAD_OVERSIZE'}
  $peek=$script:Utf8.GetString($raw)|ConvertFrom-Json -ErrorAction Stop
  if([string]$peek.client_id -notmatch '^[a-z][a-z0-9-]{2,39}$'){throw 'INVALID_CLIENT'}
  $trusted=@($trust.clients|Where-Object{$_.client_id -ceq $peek.client_id -and $_.enabled})
  if($trusted.Count -ne 1){throw 'CLIENT_DISABLED'}
  $certFile=Join-Path $script:BridgeRoot ('trust\'+$peek.client_id+'.cer')
  Assert-FileSha $certFile ([string]$trusted[0].certificate_sha256)
  $signed=Get-SignedPayloadBytes $envelopeBytes $certFile 8192
  $p=$signed.Data
  Assert-Props $p @('schema','kind','verification_id','for_request_id','goal_id','client_id',
   'created_unix_ms','observed_change','verification_method','effect_verified','evidence_sha256','project_id','chat_id')
  if($p.schema -ne 1 -or $p.kind -cne 'verification' -or $p.verification_id -cne $verificationId -or
   $p.client_id -cne $mailbox -or -not(Test-IsUuid ([string]$p.for_request_id)) -or
   -not(Test-IsUuid ([string]$p.goal_id))){throw 'BAD_VERIFICATION_SCOPE'}
  $when=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.created_unix_ms)
  if($when -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $when -lt [DateTimeOffset]::UtcNow.AddMinutes(-12)){throw 'VERIFICATION_EXPIRED'}
  if([string]$p.observed_change -notmatch '^.{8,2000}$' -or
    [string]$p.verification_method -notmatch '^.{8,500}$' -or
    [string]$p.evidence_sha256 -notmatch '^$|^[a-f0-9]{64}$' -or
    $p.effect_verified -isnot [bool]){throw 'VERIFICATION_CONTENT_INVALID'}
  $parentPath=Join-Path $script:BridgeRoot ('audit\'+$p.for_request_id+'.result.json')
  $parent=Read-JsonFile $parentPath 1048576
  if($parent.client_id -cne $p.client_id -or $parent.goal_id -cne $p.goal_id -or
   $parent.status -notin @('completed-unverified-effect','timed_out','uncertain-or-failed')){throw 'VERIFICATION_PARENT_MISMATCH'}
  $report=[ordered]@{schema=1;verification_id=$verificationId;for_request_id=[string]$p.for_request_id;
   goal_id=[string]$p.goal_id;client_id=[string]$p.client_id;created_unix_ms=[long]$p.created_unix_ms;
   recorded_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
   attestation='SIGNED_CLIENT_ASSERTION_NOT_INDEPENDENT_OS_PROOF';
   observed_change=Remove-Secrets ([string]$p.observed_change) 2000;
   verification_method=Remove-Secrets ([string]$p.verification_method) 500;
   effect_verified_claim=[bool]$p.effect_verified;
   evidence_sha256=[string]$p.evidence_sha256;
   project_id=[string]$p.project_id;chat_id=[string]$p.chat_id;
   signer_certificate_sha256=$signed.CertSha256}
  Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$p.for_request_id+'.'+$verificationId+'.verification.json')) $report
  $message.status='recorded';$message.for_request_id=[string]$p.for_request_id;$message.client_id=[string]$p.client_id
 } catch {
  $message.reason=Remove-Secrets ([string]$_.Exception.Message) 300
  Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$verificationId+'.verification-denied.json')) $message
 } finally {
  Write-JsonNew (Join-Path $script:BridgeRoot ('outbox\'+$mailbox+'\'+$verificationId+'.verify-result.json')) $message
 }
}
