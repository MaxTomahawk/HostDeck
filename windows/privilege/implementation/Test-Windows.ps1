# Read-only REAL WINDOWS preflight. Never exercises elevated command execution.
[CmdletBinding()]
param([switch]$IncludeClientDirectories)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
$checks=New-Object System.Collections.Generic.List[object]
function Assert-ClientRight([string]$Path,[string]$Sid,[string]$Right) {
 $wanted=[Security.AccessControl.FileSystemRights]$Right
 $rules=(Get-Acl -LiteralPath $Path).GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])
 $match=@($rules|Where-Object{$_.IdentityReference.Value -eq $Sid -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    (($_.FileSystemRights -band $wanted) -eq $wanted)})
 if($match.Count -lt 1){throw ('MISSING_CLIENT_RIGHT: '+$Path+' '+$Sid+' '+$Right)}
}
function Check([string]$Name,[scriptblock]$Test) {
 try { $detail=& $Test; $checks.Add([pscustomobject]@{Check=$Name;Status='PASS';Detail=[string]$detail}) }
 catch { $checks.Add([pscustomobject]@{Check=$Name;Status='FAIL';Detail=[string]$_.Exception.Message}) }
}
Check 'Windows PowerShell version' { if($PSVersionTable.PSVersion.Major -ne 5){throw 'Windows PowerShell 5.1 required'}; $PSVersionTable.PSVersion.ToString() }
Check 'Protected root' {Assert-NoReparse $script:BridgeRoot; $allowed=@('S-1-5-18','S-1-5-32-544') + @((Read-Trust).clients|ForEach-Object{[string]$_.windows_sid}); Assert-ExactAcl $script:BridgeRoot $allowed; 'ACL inheritance blocked'}
Check 'Settings and broker source integrity' {
 $s=Read-Settings
 if(-not $s.enabled){throw 'BROKER_DISABLED'}
 foreach($f in @('Bridge.Common.ps1','Broker.Tick.ps1','Broker.Verify.ps1','PrivilegedJobRunner.exe')){
  Assert-NoReparse (Join-Path $script:BridgeRoot ('bin\'+$f))
  Assert-ExactAcl (Join-Path $script:BridgeRoot ('bin\'+$f)) @('S-1-5-18','S-1-5-32-544')
 }
 Assert-FileSha (Join-Path $script:BridgeRoot 'bin\PrivilegedJobRunner.exe') ([string]$s.runner_sha256)
 'runner hash and bin ACLs verified'
}
Check 'Scheduler registration' {
 $t=Get-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction Stop
 if($t.Principal.UserId -notin @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')){throw 'WRONG_TASK_IDENTITY'}
 if($t.State -eq 'Disabled'){throw 'TASK_DISABLED'}
 $svc=New-Object -ComObject Schedule.Service;$svc.Connect()
 $reg=$svc.GetFolder('\').GetTask('CodexMandateBridge')
 $acl=[Security.AccessControl.RawSecurityDescriptor]::new([string]$reg.GetSecurityDescriptor(4))
 if(-not ($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)){throw 'TASK_DACL_UNPROTECTED'}
 foreach($ace in $acl.DiscretionaryAcl){
  if($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.SecurityIdentifier.Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'TASK_ACL_UNEXPECTED'}
 }
 'SYSTEM principal, enabled, ACL restricted'
}
Check 'Trust and client folder ACLs' {
 $t=Read-Trust
 foreach($c in $t.clients){
  Assert-FileSha (Join-Path $script:BridgeRoot ('trust\'+$c.client_id+'.cer')) ([string]$c.certificate_sha256)
  Assert-ExactAcl (Join-Path $script:BridgeRoot ('inbox\'+$c.client_id)) @('S-1-5-18','S-1-5-32-544',[string]$c.windows_sid)
  Assert-ExactAcl (Join-Path $script:BridgeRoot ('outbox\'+$c.client_id)) @('S-1-5-18','S-1-5-32-544',[string]$c.windows_sid)
  Assert-ClientRight (Join-Path $script:BridgeRoot ('inbox\'+$c.client_id)) ([string]$c.windows_sid) 'Modify'
  Assert-ClientRight (Join-Path $script:BridgeRoot ('outbox\'+$c.client_id)) ([string]$c.windows_sid) 'ReadAndExecute'
 }
 'enrolled client certificates and folder ACLs'
}
Check 'Owner public key pin' { $s=Read-Settings; Assert-FileSha (Join-Path $script:BridgeRoot 'trust\owner.cer') ([string]$s.owner_cert_sha256); 'public hash matches; signer isolation must be validated separately' }
Check 'Audit and recovery directories' {
 foreach($dir in @('audit','state','work','work\jobs')) {Assert-ExactAcl (Join-Path $script:BridgeRoot $dir) @('S-1-5-18','S-1-5-32-544')}
 'protected; external immutable copy not installed'
}
if($IncludeClientDirectories){
 Check 'Public client tools' {foreach($c in (Read-Trust).clients){ Assert-ClientRight (Join-Path $script:BridgeRoot 'public') ([string]$c.windows_sid) 'ReadAndExecute' };foreach($f in @('Bridge.Common.ps1','Submit-AdminRequest.ps1','Submit-Verification.ps1','Read-ClientReceipts.ps1')){if(-not(Test-Path -LiteralPath (Join-Path $script:BridgeRoot ('public\'+$f)))){throw ('MISSING_PUBLIC_TOOL '+$f)}};'client tools present'}
}
$checks
if(@($checks|Where-Object{$_.Status -eq 'FAIL'}).Count -gt 0){exit 1}
