# Disable one enrolled signing key without altering other clients. Explicit elevated human action.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$ClientId,
 [switch]$Apply)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-Elevated
$trust=Read-Trust
$matched=@($trust.clients|Where-Object{$_.client_id -ceq $ClientId})
if($matched.Count -ne 1){throw 'ENROLLED_CLIENT_NOT_FOUND'}
if(-not $Apply){Write-Output ('DRY RUN: would disable certificate '+$ClientId+' and retain all logs and other clients.');return}
$id=[guid]::NewGuid().ToString('D')
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$id+'.intent.json')) ([ordered]@{
 schema=1;request_id=$id;received_utc=[DateTimeOffset]::UtcNow.ToString('o');
 action='client.revoke';client_id='human-owner';revoked_client_id=$ClientId;
 goal='Revoke one Windows administrative client credential';risk='critical';
 mandate_evidence='Explicit elevated owner transaction'})
foreach($c in $trust.clients){if($c.client_id -ceq $ClientId){$c.enabled=$false}}
$path=Join-Path $script:BridgeRoot 'trust\clients.json'
Write-JsonAtomic $path $trust
Set-ExactAcl $path
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$id+'.result.json')) ([ordered]@{
 schema=1;request_id=$id;goal='Revoke one credential';client_id='human-owner';
 revoked_client_id=$ClientId;status='revoked';observed_change='client trust enabled=false';
 finished_utc=[DateTimeOffset]::UtcNow.ToString('o');
 finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()})
Write-Output ('REVOKED '+$ClientId+'; unexpired signed requests from this key will be denied after trust reload. Audit preserved.')
