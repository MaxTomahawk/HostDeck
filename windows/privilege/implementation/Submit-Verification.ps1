# Signed client assertion of observed result. No elevation; not an independent attestation.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$ClientId,
 [Parameter(Mandatory)][string]$CertificateThumbprint,
 [Parameter(Mandatory)][string]$OriginalRequestId,
 [Parameter(Mandatory)][string]$GoalId,
 [Parameter(Mandatory)][ValidateLength(8,2000)][string]$ObservedChange,
 [Parameter(Mandatory)][ValidateLength(8,500)][string]$VerificationMethod,
 [Parameter(Mandatory)][bool]$EffectVerified,
 [ValidatePattern('^$|^[a-fA-F0-9]{64}$')][string]$EvidenceSha256='',
 [string]$ProjectId='', [string]$ChatId='')
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
if(-not(Test-IsUuid $OriginalRequestId) -or -not(Test-IsUuid $GoalId)){throw 'INVALID_REQUEST_OR_GOAL'}
$cert=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$CertificateThumbprint) -ErrorAction Stop
if(-not $cert.HasPrivateKey){throw 'CLIENT_PRIVATE_KEY_UNAVAILABLE'}
$verificationId=[guid]::NewGuid().ToString('D')
$payload=[ordered]@{schema=1;kind='verification';verification_id=$verificationId;
 for_request_id=$OriginalRequestId;goal_id=$GoalId;client_id=$ClientId;
 created_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
 observed_change=$ObservedChange;verification_method=$VerificationMethod;
 effect_verified=$EffectVerified;evidence_sha256=$EvidenceSha256.ToLowerInvariant();
 project_id=$ProjectId;chat_id=$ChatId}
$envelope=New-SignedEnvelope $payload $cert
$base=Join-Path $script:BridgeRoot ('inbox\'+$ClientId+'\'+$verificationId)
Write-JsonNew ($base+'.part') $envelope
[IO.File]::Move(($base+'.part'),($base+'.verify.json'))
Write-Output ('SUBMITTED VERIFICATION '+$verificationId+' for request '+$OriginalRequestId+'; client claimed effect_verified='+$EffectVerified)
