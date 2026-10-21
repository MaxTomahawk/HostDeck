# One-time explicitly HUMAN-APPROVED administrator transaction. NO changes without -Apply.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ClientEnrollmentJson,
 [Parameter(Mandatory)][string]$OwnerPublicCertificate,
 [Parameter(Mandatory)][string]$RunnerExecutable,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedRunnerSha256,
 [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSourceManifestSha256,
 [string]$ExpectedEnrollmentSha256='', [string]$ExpectedOwnerCertificateSha256='',
 [switch]$Apply)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Bridge.Common.ps1')
if($Apply){Assert-Elevated}
$root=$script:BridgeRoot
if(Test-Path -LiteralPath $root){throw 'BRIDGE_ALREADY_EXISTS: never overwrite in place'}
if(Get-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction SilentlyContinue){throw 'TASK_ALREADY_EXISTS'}
if ($ExpectedEnrollmentSha256 -and $ExpectedEnrollmentSha256 -notmatch '^[a-fA-F0-9]{64}$') {throw 'INVALID_ENROLLMENT_DIGEST'}
if ($ExpectedOwnerCertificateSha256 -and $ExpectedOwnerCertificateSha256 -notmatch '^[a-fA-F0-9]{64}$') {throw 'INVALID_OWNER_DIGEST'}
$enrollmentHash=Get-FileSha $ClientEnrollmentJson
if ($ExpectedEnrollmentSha256 -and $ExpectedEnrollmentSha256.ToLowerInvariant() -cne $enrollmentHash){throw 'ENROLLMENT_HASH_MISMATCH'}
$clients=Read-JsonFile $ClientEnrollmentJson 65536
if($clients.schema -ne 1 -or @($clients.clients).Count -lt 1 -or @($clients.clients).Count -gt 4){throw 'CLIENT_ENROLLMENT_INVALID'}
$clientNames=@{};$trustedClients=@();$sids=@();$clientCertBytes=@{}
foreach($c in $clients.clients){
 if([string]$c.client_id -notmatch '^[a-z][a-z0-9-]{2,39}$' -or $clientNames.ContainsKey([string]$c.client_id)) {throw 'DUPLICATE_OR_BAD_CLIENT_ID'}
 if([string]$c.windows_sid -notmatch '^S-1-5-(?:\d+-)+\d+$' -or $c.windows_sid -in @('S-1-5-18','S-1-5-32-544')){throw 'INVALID_CLIENT_WINDOWS_SID'}
 $clientNames[[string]$c.client_id]=$true
 $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $c.public_certificate).Path)
 try {
  if($public.HasPrivateKey){throw 'ENROLL_PUBLIC_CERT_ONLY'}
  $digest=Get-CertHash $public
  $thumbprint=[string]$public.Thumbprint
  $clientCertBytes[[string]$c.client_id]=[byte[]]$public.RawData.Clone()
 }finally{$public.Dispose()}
 $trustedClients+= [ordered]@{client_id=[string]$c.client_id;windows_sid=[string]$c.windows_sid;
  certificate_sha256=$digest;certificate_thumbprint=$thumbprint;enabled=$true;surface=[string]$c.surface}
 $sids+= [string]$c.windows_sid
}
$owner=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $OwnerPublicCertificate).Path)
try{if($owner.HasPrivateKey){throw 'OWNER_PUBLIC_CERT_ONLY'};$ownerHash=Get-CertHash $owner;$ownerBytes=[byte[]]$owner.RawData.Clone()}finally{$owner.Dispose()}
if($trustedClients | Where-Object{$_.certificate_sha256 -ceq $ownerHash}){throw 'OWNER_AND_CLIENT_CERTIFICATE_SAME'}
if($ExpectedOwnerCertificateSha256 -and $ExpectedOwnerCertificateSha256.ToLowerInvariant() -cne $ownerHash){throw 'OWNER_CERT_HASH_MISMATCH'}
$runnerFull=(Resolve-Path -LiteralPath $RunnerExecutable).Path
if((Get-FileSha $runnerFull) -cne $ExpectedRunnerSha256.ToLowerInvariant()){throw 'RUNNER_HASH_MISMATCH'}
$sourcePaths=@('Bridge.Common.ps1','Broker.Tick.ps1','Broker.Verify.ps1','Submit-AdminRequest.ps1','Submit-Verification.ps1','Read-Audit.ps1')
$publicPaths=@('Bridge.Common.ps1','Submit-AdminRequest.ps1','Submit-Verification.ps1','Read-ClientReceipts.ps1')
$manifestPath=Join-Path $PSScriptRoot 'source-sha256.json'
Assert-NoReparse $manifestPath
$manifestBytes=[IO.File]::ReadAllBytes($manifestPath)
if($manifestBytes.Length -lt 2 -or $manifestBytes.Length -gt 32768 -or
 (Get-Sha256 $manifestBytes) -cne $ExpectedSourceManifestSha256.ToLowerInvariant()){throw 'SOURCE_MANIFEST_HASH_MISMATCH'}
$sourceManifest=$script:Utf8.GetString($manifestBytes)|ConvertFrom-Json -ErrorAction Stop
if($sourceManifest.schema -ne 1 -or @($sourceManifest.files).Count -lt 7){throw 'SOURCE_MANIFEST_INVALID'}
$manifestMap=@{}
foreach($entry in $sourceManifest.files){
 $name=[string]$entry.name;$digest=[string]$entry.sha256
 if($name -cnotmatch '^[A-Za-z0-9.-]+\.ps1$' -or $digest -cnotmatch '^[a-f0-9]{64}$' -or $manifestMap.ContainsKey($name)){
  throw 'SOURCE_MANIFEST_ENTRY_INVALID'
 }
 $manifestMap[$name]=$digest
}
$actualSources=@(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)
if($manifestMap.Count -ne $actualSources.Count){throw 'SOURCE_MANIFEST_FILESET_MISMATCH'}
$sourceBytes=@{}
foreach($file in $actualSources){
 if(-not $manifestMap.ContainsKey($file.Name)){throw 'SOURCE_MANIFEST_FILESET_MISMATCH'}
 Assert-NoReparse $file.FullName
 $bytes=[IO.File]::ReadAllBytes($file.FullName)
 if((Get-Sha256 $bytes) -cne $manifestMap[$file.Name]){throw ('SOURCE_HASH_MISMATCH: '+$file.Name)}
 $sourceBytes[$file.Name]=$bytes
}
foreach($name in @($sourcePaths)+@($publicPaths)){if(-not $sourceBytes.ContainsKey($name)){throw 'MISSING_BROKER_SOURCE'}}
Write-Output 'PREFLIGHT: reviewed public certificates, SID inputs, protected task namespace and runner hash.'
foreach($c in $trustedClients){Write-Output ('CLIENT '+$c.client_id+' SID '+$c.windows_sid+' PUBKEY_SHA256 '+$c.certificate_sha256)}
Write-Output ('OWNER_CERT_SHA256 '+$ownerHash)
Write-Output ('ENROLLMENT_SHA256 '+$enrollmentHash)
if ($sids.Count -ne @($sids|Select-Object -Unique).Count) {Write-Warning 'MULTIPLE_CLIENTS_SAME_SID: no process-level exclusivity; each same-SID process may use accessible signing keys.'}
if(-not $Apply){Write-Output 'DRY RUN ONLY. Re-run with -Apply and verified expected enrollment, owner and runner SHA-256 values after owner consent.';return}
if (-not $ExpectedEnrollmentSha256 -or -not $ExpectedOwnerCertificateSha256){throw 'INSTALL_REQUIRES_PINNED_ENROLLMENT_AND_OWNER'}
Assert-FileSha $ClientEnrollmentJson $ExpectedEnrollmentSha256.ToLowerInvariant()
Assert-FileSha $OwnerPublicCertificate $ExpectedOwnerCertificateSha256.ToLowerInvariant()
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
Set-ExactAcl $root
foreach($dir in @('bin','public','trust','inbox','outbox','audit','work','work\jobs','state')){
 New-Item -ItemType Directory -Path (Join-Path $root $dir) -ErrorAction Stop | Out-Null
 Set-ExactAcl (Join-Path $root $dir)
}
# Owner controls all trust/code/audit; clients only get submit and receipt-read folders.
$uniqueSids=@($sids|Select-Object -Unique)
foreach($c in $trustedClients){
 $folder=Join-Path $root ('inbox\'+$c.client_id)
 New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
 Set-ExactAcl $folder @([string]$c.windows_sid) 'Modify'
 $receiptFolder=Join-Path $root ('outbox\'+$c.client_id)
 New-Item -ItemType Directory -Path $receiptFolder -ErrorAction Stop | Out-Null
 Set-ExactAcl $receiptFolder @([string]$c.windows_sid) 'ReadAndExecute'
}
Set-ExactAcl $root $uniqueSids 'ReadAndExecute'
Set-ExactAcl (Join-Path $root 'public') $uniqueSids 'ReadAndExecute'
foreach($name in $sourcePaths){
 $destination=Join-Path $root ('bin\'+$name)
 [IO.File]::WriteAllBytes($destination,[byte[]]$sourceBytes[$name])
 Set-ExactAcl $destination
 Assert-FileSha $destination $manifestMap[$name]
}
foreach($name in $publicPaths) {
 $destination=Join-Path $root ('public\'+$name)
 [IO.File]::WriteAllBytes($destination,[byte[]]$sourceBytes[$name])
 Set-ExactAcl $destination $uniqueSids 'ReadAndExecute'
 Assert-FileSha $destination $manifestMap[$name]
}
Copy-Item -LiteralPath $runnerFull -Destination (Join-Path $root 'bin\PrivilegedJobRunner.exe')
Set-ExactAcl (Join-Path $root 'bin\PrivilegedJobRunner.exe')
Assert-FileSha (Join-Path $root 'bin\PrivilegedJobRunner.exe') $ExpectedRunnerSha256.ToLowerInvariant()
$ownerDest=Join-Path $root 'trust\owner.cer'
[IO.File]::WriteAllBytes($ownerDest,$ownerBytes)
Set-ExactAcl $ownerDest
Assert-FileSha $ownerDest $ownerHash
foreach($c in $clients.clients){
 $destination=Join-Path $root ('trust\'+[string]$c.client_id+'.cer')
 [IO.File]::WriteAllBytes($destination,[byte[]]$clientCertBytes[[string]$c.client_id])
 Set-ExactAcl $destination
 $entry=@($trustedClients|Where-Object{$_.client_id -ceq [string]$c.client_id})
 if($entry.Count -ne 1){throw 'CLIENT_CERT_SNAPSHOT_MISSING'}
 Assert-FileSha $destination ([string]$entry[0].certificate_sha256)
}
[IO.File]::WriteAllBytes((Join-Path $root 'bin\source-sha256.json'),$manifestBytes)
Set-ExactAcl (Join-Path $root 'bin\source-sha256.json')
Assert-FileSha (Join-Path $root 'bin\source-sha256.json') $ExpectedSourceManifestSha256.ToLowerInvariant()
$trustPayload=[ordered]@{schema=1;clients=$trustedClients}
Write-JsonNew (Join-Path $root 'trust\clients.json') $trustPayload
Set-ExactAcl (Join-Path $root 'trust\clients.json')
$publicClients=[ordered]@{schema=1;bridge_root=$root;clients=@($trustedClients|ForEach-Object{
 [ordered]@{client_id=$_.client_id;windows_sid=$_.windows_sid;
  certificate_thumbprint=$_.certificate_thumbprint;certificate_store='CurrentUser\My'}
})}
Write-JsonNew (Join-Path $root 'public\clients.json') $publicClients
Set-ExactAcl (Join-Path $root 'public\clients.json') $uniqueSids 'ReadAndExecute'
$settings=[ordered]@{schema=1;enabled=$true;owner_cert_sha256=$ownerHash;
 runner_sha256=$ExpectedRunnerSha256.ToLowerInvariant();created_utc=[DateTimeOffset]::UtcNow.ToString('o');
 authorization_model='persistent-delegation-to-enrolled-client-keys';
 request_mandate_source='client-assessed-not-cryptographically-verifiable';
 critical_goal_approval='separate-owner-key'}
Write-JsonNew (Join-Path $root 'settings.json') $settings
Set-ExactAcl (Join-Path $root 'settings.json')
# Explicit ACL gate prior to privileged persistence.
foreach($dir in @('bin','trust','audit','work','work\jobs','state')){
 Assert-ExactAcl (Join-Path $root $dir) @('S-1-5-18','S-1-5-32-544')
}
$bootstrapId=[guid]::NewGuid().ToString('D')
$start=[DateTimeOffset]::UtcNow
Write-JsonNew (Join-Path $root ('audit\'+$bootstrapId+'.intent.json')) ([ordered]@{
 schema=1;request_id=$bootstrapId;received_utc=$start.ToString('o');client_id='owner-in-person';
 goal='One-time delegated broad Windows administration';mandate_evidence='Human approved elevated installer';
 risk='critical';action='register-SYSTEM-task';outcome='started'})
# COM Task Scheduler native API; indefinite PT1M repetition (no Duration) + boot start.
$svc=New-Object -ComObject 'Schedule.Service';$svc.Connect()
$folder=$svc.GetFolder('\');$task=$svc.NewTask(0)
$task.RegistrationInfo.Description='Signed client-delegated general Windows administration with protected audit'
$task.Principal.UserId='SYSTEM';$task.Principal.LogonType=5;$task.Principal.RunLevel=1
$boot=$task.Triggers.Create(8);$boot.Enabled=$true
$daily=$task.Triggers.Create(2)
$daily.StartBoundary=(Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$daily.DaysInterval=1
$daily.Repetition.Interval='PT1M'
# Never set Repetition.Duration: Microsoft specifies omitted Duration = repeat indefinitely.
$exe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $root 'bin\Broker.Tick.ps1')+'"'
$action=$task.Actions.Create(0);$action.Path=$exe;$action.Arguments=$arguments
$task.Settings.Enabled=$true;$task.Settings.StartWhenAvailable=$true
$task.Settings.ExecutionTimeLimit='PT20M';$task.Settings.MultipleInstances=2
$task.Settings.DisallowStartIfOnBatteries=$false;$task.Settings.StopIfGoingOnBatteries=$false
$registered=$folder.RegisterTaskDefinition('CodexMandateBridge',$task,6,'SYSTEM',$null,5,$null)
try {
$registered.SetSecurityDescriptor('O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)',16)
$effective=[Security.AccessControl.RawSecurityDescriptor]::new([string]$registered.GetSecurityDescriptor(4))
if(($effective.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) {throw 'TASK_DACL_NOT_PROTECTED'}
foreach($ace in $effective.DiscretionaryAcl){
 if($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $ace.SecurityIdentifier.Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'UNEXPECTED_TASK_ACL'}
}
$check=Get-ScheduledTask -TaskName 'CodexMandateBridge' -ErrorAction Stop
if($check.Principal.UserId -notin @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')){throw 'TASK_PRINCIPAL_MISMATCH'}
Write-JsonNew (Join-Path $root ('audit\'+$bootstrapId+'.result.json')) ([ordered]@{
 schema=1;request_id=$bootstrapId;finished_utc=[DateTimeOffset]::UtcNow.ToString('o');finished_unix_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
 status='registered-not-validated-on-Windows';outcome='scheduled-task-registered';
 risk='critical';identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value})
} catch {
 try { $registered.Enabled=$false } catch { }
 throw
}
Write-Output 'REGISTERED, NOT ACCEPTED: execute Test-Windows.ps1, signed safe probe, negative SID/key tests, reboot and HostDeck integration.'
