# Runs as the registered NONADMINISTRATOR Codex/HostDeck client. Each script is signed, not pre-catalogued.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$ClientId,
 [Parameter(Mandatory)][string]$CertificateThumbprint,
 [Parameter(Mandatory)][string]$ScriptPath,
 [Parameter(Mandatory)][ValidateLength(8,2000)][string]$Goal,
 [Parameter(Mandatory)][ValidateLength(8,1000)][string]$ExpectedChange,
 [Parameter(Mandatory)][ValidateLength(8,1000)][string]$ActionSummary,
 [Parameter(Mandatory)][ValidateLength(8,1000)][string]$MandateEvidence,
 [ValidateSet('standard','elevated-risk','critical')][string]$Risk='standard',
 [string]$GoalId='', [string]$RetryOf='', [string]$ProjectId='', [string]$ChatId='',
 [string]$OwnerApprovalBundlePath='', [ValidateRange(10,900)][int]$TimeoutSeconds=180,
 [ValidateRange(0,900)][int]$WaitSeconds=75
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
if($GoalId -and -not (Test-IsUuid $GoalId)){throw 'INVALID_GOAL_ID'}
if($RetryOf -and -not (Test-IsUuid $RetryOf)){throw 'INVALID_RETRY_REFERENCE'}
if(-not $GoalId){$GoalId=[guid]::NewGuid().ToString('D')}
if($Goal -match '(?i)\b(password|token|secret|bearer|authorization)\s*[:=]'){throw 'SECRET_IN_GOAL'}
$rawScript=[IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ScriptPath).Path)
if($rawScript.Length -lt 1 -or $rawScript.Length -gt 131069){throw 'SCRIPT_SIZE_EXCEEDED'}
# Windows PowerShell 5.1 needs a BOM for deterministic UTF-8 decoding. Normalize before signing.
$decoded=$script:Utf8.GetString($rawScript)
if($decoded.Length -gt 0 -and $decoded[0] -eq [char]0xFEFF){$decoded=$decoded.Substring(1)}
$scriptBytes=[byte[]]@(0xEF,0xBB,0xBF)+$script:Utf8.GetBytes($decoded)
$cert=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$CertificateThumbprint) -ErrorAction Stop
if(-not $cert.HasPrivateKey){throw 'NO_CLIENT_PRIVATE_KEY'}
$reqId=[guid]::NewGuid().ToString('D')
if($Risk -eq 'critical' -and -not $OwnerApprovalBundlePath){throw 'OWNER_APPROVAL_REQUIRED_FOR_CRITICAL_RISK'}
$ownerApprovalBytes=@()
if($OwnerApprovalBundlePath){$ownerApprovalBytes=[IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $OwnerApprovalBundlePath).Path)
 if($ownerApprovalBytes.Length -gt 65536){throw 'APPROVAL_OVERSIZED'}}
$payload=[ordered]@{schema=1;request_id=$reqId;created_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();client_id=$ClientId;
 goal_id=$GoalId;goal=$Goal;mandate_evidence=$MandateEvidence;mandate_attestation='client-assessed-not-owner-cryptographically-verified';
 risk=$Risk;action_summary=$ActionSummary;expected_change=$ExpectedChange;project_id=$ProjectId;chat_id=$ChatId;retry_of=$RetryOf;
 timeout_seconds=$TimeoutSeconds;script_base64=[Convert]::ToBase64String($scriptBytes);
 script_sha256=(Get-Sha256 $scriptBytes);owner_approval_base64=[Convert]::ToBase64String([byte[]]$ownerApprovalBytes)}
$envelope=New-SignedEnvelope $payload $cert
$root=$script:BridgeRoot;$pending=Join-Path $root ('inbox\'+$ClientId+'\'+$reqId+'.part');$ready=Join-Path $root ('inbox\'+$ClientId+'\'+$reqId+'.request.json')
Write-JsonNew $pending $envelope
[IO.File]::Move($pending,$ready)
Write-Output ('Submitted request '+$reqId+'; goal '+$GoalId+'. No UAC requested.')
if($WaitSeconds -eq 0){return}
$deadline=[DateTimeOffset]::UtcNow.AddSeconds($WaitSeconds)
do {
 $receipt=Join-Path $root ('outbox\'+$ClientId+'\'+$reqId+'.result.json')
 if(Test-Path -LiteralPath $receipt){Read-JsonFile $receipt 1048576;return}
 Start-Sleep -Seconds 2
}while([DateTimeOffset]::UtcNow -lt $deadline)
Write-Output ('PENDING '+$reqId+'; never resubmit automatically. Inspect your client-specific outbox or ask an authorized auditor.')
