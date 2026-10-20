# Resolve an interrupted request ONLY after independent OS inspection. Never replay automatically.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$RequestId,
 [Parameter(Mandatory)][ValidateLength(8,500)][string]$Evidence,
 [ValidateSet('uncertain','failed','verified-completed')][string]$ObservedOutcome='uncertain',
 [switch]$Apply)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
Assert-Elevated
if(-not(Test-IsUuid $RequestId)){throw 'BAD_ID'}
$intent=Join-Path $script:BridgeRoot ('audit\'+$RequestId+'.intent.json')
$result=Join-Path $script:BridgeRoot ('audit\'+$RequestId+'.result.json')
if(-not (Test-Path -LiteralPath $intent) -or (Test-Path -LiteralPath $result)){throw 'NO_UNRESOLVED_INTENT'}
if(-not $Apply){Write-Output 'DRY RUN: will record manually verified state; never replay same request.';return}
Write-JsonNew $result ([ordered]@{schema=1;request_id=$RequestId;goal_id='';client_id='human-owner';
 goal='Recovery after interrupted elevated request';risk='critical';status=$ObservedOutcome;error_code='MANUALLY_RECONCILED';
 observed_change=$Evidence;retry_of='';project_id='';chat_id='';exit_code=$null;
 finished_utc=[DateTimeOffset]::UtcNow.ToString('o');finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()})
Write-Output ('RECONCILED '+$RequestId+'; user must decide whether a NEW authorized retry is appropriate.')
