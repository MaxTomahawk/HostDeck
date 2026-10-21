# Read-only audit summary; scripts/output are under SYSTEM-protected work directory.
[CmdletBinding()]
param([ValidateRange(1,250)][int]$Last=40,[string]$GoalId='', [switch]$IncludeDetails)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$zone=[TimeZoneInfo]::FindSystemTimeZoneById('W. Europe Standard Time')
function Field($o,[string]$name,$default=''){
 $prop=$o.PSObject.Properties[$name]
 if($null -eq $prop -or $null -eq $prop.Value){return $default}
 return $prop.Value
}
Get-ChildItem -LiteralPath (Join-Path $script:BridgeRoot 'audit') -Filter '*.result.json' -File |
 Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $Last | ForEach-Object {
  $r=Read-JsonFile $_.FullName 1048576
  if($GoalId -and (Field $r 'goal_id') -cne $GoalId){return}
  $rawTime=Field $r 'finished_unix_ms' $null
  if($null -ne $rawTime){$utc=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$rawTime)}
  else {
    $oldTime=Field $r 'finished_utc' $null
    if($null -eq $oldTime){throw 'MISSING_AUDIT_TIME'}
    if($oldTime -is [datetime]){$utc=[DateTimeOffset]::new($oldTime.ToUniversalTime())}
    else {$utc=[DateTimeOffset]::Parse([string]$oldTime,[Globalization.CultureInfo]::InvariantCulture)}
  }
  $local=[TimeZoneInfo]::ConvertTime($utc,$zone)
  if($IncludeDetails){$r}
  else{[pscustomobject]@{
    DatumNL=$local.ToString('dd-MM-yyyy HH:mm:ss zzz',[Globalization.CultureInfo]::GetCultureInfo('nl-NL'))
    Aanvraag=(Field $r 'request_id');DoelID=(Field $r 'goal_id');Client=(Field $r 'client_id');Doel=(Field $r 'goal');Risico=(Field $r 'risk')
    Resultaat=(Field $r 'status');ExitCode=(Field $r 'exit_code');RetryVan=(Field $r 'retry_of');Project=(Field $r 'project_id');Chat=(Field $r 'chat_id')
    VerificatieEffect=(Field $r 'observed_change')
  }}
}
