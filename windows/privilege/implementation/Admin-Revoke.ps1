# Emergency revocation, require separate HUMAN admin approval; preserve audit and evidence.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-Elevated
$settingsPath=Join-Path $script:BridgeRoot 'settings.json'
if(-not (Test-Path -LiteralPath $settingsPath)) {throw 'BRIDGE_NOT_FOUND'}
if(-not $Apply){Write-Output 'DRY RUN: would disable bridge and Task Scheduler entry, retaining audit. Use -Apply after explicit approval.';return}
$settings=Read-Settings
$settings.enabled=$false
Write-JsonAtomic $settingsPath $settings
Set-ExactAcl $settingsPath
Disable-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction Stop | Out-Null
# Do not delete audit or protected files; already-started privileged effects may persist.
$stamp=[guid]::NewGuid().ToString('D')
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$stamp+'.intent.json')) ([ordered]@{
 schema=1;request_id=$stamp;received_utc=[DateTimeOffset]::UtcNow.ToString('o');
 goal='Revoke local general administrator bridge';action='broker.revoke';mandate_evidence='Human elevated emergency action';
 client_id='human-owner';risk='critical'})
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$stamp+'.result.json')) ([ordered]@{
 schema=1;request_id=$stamp;finished_utc=[DateTimeOffset]::UtcNow.ToString('o');finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
 goal_id='';goal='Bridge disabled';risk='critical';client_id='human-owner';status='revoked';
 observed_change='settings.enabled=false and scheduled task disabled';retry_of='';project_id='';chat_id='';exit_code=0})
Write-Output 'REVOKED: task disabled; audit retained. Elevated code launched earlier may not be cancellable from this script.'
