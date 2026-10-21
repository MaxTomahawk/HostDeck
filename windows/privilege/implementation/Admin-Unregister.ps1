# Explicit human uninstall of scheduled SYSTEM execution. Preserve audit and local evidence.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-Elevated
if(-not(Test-Path -LiteralPath (Join-Path $script:BridgeRoot 'settings.json'))){throw 'BRIDGE_NOT_INSTALLED'}
if(-not $Apply){Write-Output 'DRY RUN: will disable and unregister CodexMandateBridge task; retain all files, audit and certificates.';return}
$id=[guid]::NewGuid().ToString('D')
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$id+'.intent.json')) ([ordered]@{
 schema=1;request_id=$id;received_utc=[DateTimeOffset]::UtcNow.ToString('o');
 goal='Permanently unregister broad Windows administrative task';
 action='broker.unregister';risk='critical';client_id='human-owner';
 mandate_evidence='Explicit elevated owner transaction'})
$settings=Read-Settings
$settings.enabled=$false
Write-JsonAtomic (Join-Path $script:BridgeRoot 'settings.json') $settings
Set-ExactAcl (Join-Path $script:BridgeRoot 'settings.json')
$task=Get-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction SilentlyContinue
if($task){
 Disable-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction Stop|Out-Null
 Unregister-ScheduledTask -TaskName 'CodexMandateBridge' -Confirm:$false -ErrorAction Stop
}
Write-JsonNew (Join-Path $script:BridgeRoot ('audit\'+$id+'.result.json')) ([ordered]@{
 schema=1;request_id=$id;status='unregistered';client_id='human-owner';
 goal='Privileged task removed';observed_change='Task Scheduler registration removed, settings disabled; files retained';
 finished_utc=[DateTimeOffset]::UtcNow.ToString('o');
 finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()})
Write-Output 'TASK UNREGISTERED. Private keys remain in their own user stores; revoke/delete them separately. Protected audit and work files retained.'
