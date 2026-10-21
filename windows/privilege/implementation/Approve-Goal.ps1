# Execute as OWNER (different protected identity from Codex/HostDeck) for a high-impact GOAL, no UAC required.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$GoalId,[Parameter(Mandatory)][string]$ClientId,
 [Parameter(Mandatory)][string]$OwnerCertificateThumbprint,
 [switch]$MachineStoreOwnerKey,
 [Parameter(Mandatory)][ValidateLength(8,500)][string]$GoalSummary,
 [Parameter(Mandatory)][ValidateLength(8,2000)][string]$ExactGoal,
 [Parameter(Mandatory)][string]$BundlePath,
 [ValidateRange(1,168)][int]$ValidHours=24)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
if(-not (Test-IsUuid $GoalId) -or $ClientId -notmatch '^[a-z][a-z0-9-]{2,39}$'){throw 'INVALID_GOAL_OR_CLIENT'}
if($MachineStoreOwnerKey){
 $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
 if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MACHINE_OWNER_APPROVAL_REQUIRES_ELEVATION'}
}
$store=if($MachineStoreOwnerKey){'Cert:\LocalMachine\My\'}else{'Cert:\CurrentUser\My\'}
$cert=Get-Item -LiteralPath ($store+$OwnerCertificateThumbprint) -ErrorAction Stop
if(-not $cert.HasPrivateKey){throw 'OWNER_PRIVATE_KEY_UNAVAILABLE'}
$grant=[ordered]@{schema=1;goal_id=$GoalId;client_id=$ClientId;risk_ceiling='critical';
 goal_summary=$GoalSummary;goal_sha256=(Get-Sha256 ($script:Utf8.GetBytes($ExactGoal)));issued_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
 expires_unix_ms=[DateTimeOffset]::UtcNow.AddHours($ValidHours).ToUnixTimeMilliseconds()}
Write-JsonNew $BundlePath (New-SignedEnvelope $grant $cert)
Write-Output ('Owner goal authorization saved: '+$BundlePath+'; no machine UAC was requested.')
