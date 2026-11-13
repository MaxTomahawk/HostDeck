# Read-only installed qualification. MIT; see the repository LICENSE.
# PowerShell 7. No vendor/service/configuration changes or corpus queries.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Worker([string]$Mode,$Request=$null){
 $p=[Diagnostics.Process]::new()
 $p.StartInfo=[Diagnostics.ProcessStartInfo]::new($script:worker)
 $p.StartInfo.ArgumentList.Add($Mode)
 $p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true
 $p.StartInfo.RedirectStandardInput=$true;$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
 $p.StartInfo.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
 $p.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
 try{
  if(-not $p.Start()){throw 'QUALIFICATION_WORKER_UNAVAILABLE'}
  $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
  if($null -ne $Request){$p.StandardInput.WriteLine(($Request|ConvertTo-Json -Compress))}
  $p.StandardInput.Close()
  if(-not $p.WaitForExit(8000)){
   $p.Kill($true);$p.WaitForExit(2000)|Out-Null;throw 'QUALIFICATION_OWN_WORKER_TIMEOUT'
  }
  $text=$stdout.GetAwaiter().GetResult();$errors=$stderr.GetAwaiter().GetResult()
  if($p.ExitCode -ne 0 -or $text.Length -gt 65536 -or $errors.Length -gt 0){throw 'QUALIFICATION_WORKER_RESPONSE'}
  return $text|ConvertFrom-Json
 }finally{$p.Dispose()}
}
try{
 $script:stage='configuration_path'
 # HostDeck intentionally omits ProgramFiles from command environments.
 # Resolve the OS known folder without weakening that environment filter.
 $programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
 if([string]::IsNullOrEmpty($programFiles)){throw 'QUALIFICATION_PRODUCT_LOCATION_UNAVAILABLE'}
 $configPath=Join-Path $programFiles 'HostDeck/config/facade.json'
 $script:stage='configuration_read'
 $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
 $script:worker=$config.desktop_worker
 $script:stage='native_identity'
 $own=Worker '--identity'
 if(-not $own.eligible -or $own.elevated -or $own.sid -cne $config.expected_user_sid -or
    $own.session_id -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'QUALIFICATION_IDENTITY'}
 $script:stage='app_pin'
 $appHash=(Get-FileHash -LiteralPath $config.everything.executable -Algorithm SHA256).Hash.ToLowerInvariant()
 $appVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($config.everything.executable).FileVersion
 if($appHash -cne $config.everything.sha256.ToLowerInvariant() -or $appVersion -cne $config.everything.version){throw 'QUALIFICATION_APP_PIN'}
 $base=@{operation='status';executable=$config.everything.executable;sha256=$appHash;version=$appVersion;
  instance=$config.everything.instance;session_id=$own.session_id;sid=$own.sid;logon_id=$own.logon_id}
 $script:stage='positive_native_status'
 $status=(Worker '--everything' $base).result
 if(-not $status.running -or -not $status.healthy -or $status.reason -cne 'ready'){throw 'QUALIFICATION_APP_NOT_READY'}
 $cases=@()
 foreach($kind in @('wrong_session','changed_hash','wrong_version','absent_instance')){
  $script:stage='negative_'+$kind
  $request=$base.Clone()
  switch($kind){
   'wrong_session'{$request.session_id=[int]$own.session_id+1;$expected='EVERYTHING_WRONG_SESSION'}
   'changed_hash'{$request.sha256='0'*64;$expected='EVERYTHING_BINARY_CHANGED'}
   'wrong_version'{$request.version='1.5.0.0b';$expected='EVERYTHING_VERSION_UNSUPPORTED'}
   'absent_instance'{$request.instance='HD_QUAL_'+[guid]::NewGuid().ToString('N');$expected='not_running'}
  }
  $r=Worker '--everything' $request
  $observed=if($kind -eq 'absent_instance'){$r.result.reason}else{$r.error}
  if($observed -cne $expected){throw 'QUALIFICATION_NEGATIVE_MISMATCH'}
  $cases+=@{case=$kind;expected=$expected;observed=$observed;verdict='PASS'}
 }
 $script:stage='component_hash_readback'
 $manifestFile=Join-Path (Split-Path -Parent (Split-Path -Parent $script:worker)) 'manifest.json'
 $record=[ordered]@{schema=1;utc=[DateTimeOffset]::UtcNow.ToString('o');verdict='PASS';
  role='READ_ONLY_NATIVE_COMPONENT_QUALIFICATION';app_version=$appVersion;app_sha256=$appHash;
  native_exe_sha256=(Get-FileHash -LiteralPath $script:worker).Hash.ToLowerInvariant();
  native_dll_sha256=(Get-FileHash -LiteralPath ([IO.Path]::ChangeExtension($script:worker,'.dll'))).Hash.ToLowerInvariant();
  manifest_sha256=(Get-FileHash -LiteralPath $manifestFile).Hash.ToLowerInvariant();
  session_id=$own.session_id;actual_status='ready';cases=$cases;source_binding='UNKNOWN';signature_trust='UNKNOWN';
  limits='No caller-supplied identity accepted as MCP authorization. Internal negative requests only; no other session/data explored, corpus query, UI, vendor/config/grant mutation, install or lifecycle test.'}
 $record|ConvertTo-Json -Depth 6 -Compress
}catch{
 # No raw paths, SIDs, account/configuration values, stderr or exception text.
 @{schema=1;verdict='FAIL';code='QUALIFICATION_UNAVAILABLE_OR_MISMATCH';stage=$script:stage}|ConvertTo-Json -Compress
 exit 1
}
