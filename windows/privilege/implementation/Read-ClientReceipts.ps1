# Unprivileged per-client receipt reader; never grants access to protected machine-wide audit.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$ClientId,
 [ValidateRange(1,100)][int]$Last=15,
 [ValidatePattern('^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')][string]$RequestId='')
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$directory=Join-Path $script:BridgeRoot ('outbox\'+$ClientId)
Assert-NoReparse $directory
if(-not(Test-Path -LiteralPath $directory -PathType Container)){throw 'CLIENT_OUTBOX_UNAVAILABLE'}
if($RequestId){
 $receipt=Join-Path $directory ($RequestId+'.result.json')
 Assert-NoReparse $receipt
 if(Test-Path -LiteralPath $receipt -PathType Leaf){Read-JsonFile $receipt 1048576;return}
 $queued=Join-Path $script:BridgeRoot ('inbox\'+$ClientId+'\'+$RequestId+'.request.json')
 Assert-NoReparse $queued
 [pscustomobject]@{request_id=$RequestId;status=$(if(Test-Path -LiteralPath $queued -PathType Leaf){'pending'}else{'not_found'})}
 return
}
Get-ChildItem -LiteralPath $directory -Filter '*.result.json' -File |
 Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $Last | ForEach-Object {
  Read-JsonFile $_.FullName 1048576
 }
