# Windows PowerShell 5.1. Shared strict helpers. Do not source from writable paths in elevated context.
Set-StrictMode -Version Latest
$script:BridgeRoot = Join-Path $env:ProgramData 'CodexMandateBridge'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
function Assert-Elevated {
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $admin=[Security.Principal.WindowsPrincipal]::new($id)
  if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATION_REQUIRED' }
}
function Assert-System {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'SYSTEM_REQUIRED' }
}
function Assert-NoReparse([string]$Path) {
  $p=[IO.Path]::GetFullPath($Path)
  while ($p) {
    if (Test-Path -LiteralPath $p) {
      $item=Get-Item -LiteralPath $p -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "REPARSE_PATH_DENIED: $p" }
    }
    $parent=Split-Path -Parent $p
    if (-not $parent -or $parent -eq $p) { break }
    $p=$parent
  }
}
function Get-Sha256([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-FileSha([string]$Path) {
  Assert-NoReparse $Path
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Assert-FileSha([string]$Path,[string]$Expected) {
  if ($Expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileSha $Path) -cne $Expected) { throw ('PINNED_FILE_HASH_MISMATCH: ' + $Path) }
}
function Read-JsonFile([string]$Path,[int]$Maximum=2097152) {
  Assert-NoReparse $Path
  $info=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($info.Length -lt 2 -or $info.Length -gt $Maximum) { throw 'INVALID_JSON_FILE_SIZE' }
  return ($script:Utf8.GetString([IO.File]::ReadAllBytes($Path)) | ConvertFrom-Json -ErrorAction Stop)
}
function Write-JsonNew([string]$Path,$Object) {
  $json=ConvertTo-Json -InputObject $Object -Depth 20 -Compress
  $bytes=$script:Utf8.GetBytes($json+"`n")
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}
function Write-JsonAtomic([string]$Path,$Object) {
  $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
  Write-JsonNew $tmp $Object
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp,$Path,$null) }
  else { [IO.File]::Move($tmp,$Path) }
}
function Get-CertHash([Security.Cryptography.X509Certificates.X509Certificate2]$Cert) {
  return Get-Sha256 ($Cert.RawData)
}
function Get-SignedPayloadBytes([byte[]]$EnvelopeBytes,[string]$CertificatePath,[int]$MaxPayload=524288) {
  if($EnvelopeBytes.Length -lt 2 -or $EnvelopeBytes.Length -gt ($MaxPayload*3+16384)){throw 'INVALID_ENVELOPE_SIZE'}
  $envelope=$script:Utf8.GetString($EnvelopeBytes) | ConvertFrom-Json -ErrorAction Stop
  if ($envelope.schema -ne 1 -or [string]$envelope.payload_base64 -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or
    [string]$envelope.signature_base64 -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'ENVELOPE_INVALID' }
  $raw=[Convert]::FromBase64String([string]$envelope.payload_base64)
  $signature=[Convert]::FromBase64String([string]$envelope.signature_base64)
  if ($raw.Length -le 0 -or $raw.Length -gt $MaxPayload -or $signature.Length -gt 1024) { throw 'ENVELOPE_SIZE_INVALID' }
  $cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path -LiteralPath $CertificatePath).Path)
  try {
    $pub=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
    if ($null -eq $pub) { throw 'RSA_SIGNER_REQUIRED' }
    try { $valid=$pub.VerifyData($raw,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1) }
    finally { $pub.Dispose() }
    if (-not $valid) { throw 'SIGNATURE_INVALID' }
    $data=$script:Utf8.GetString($raw) | ConvertFrom-Json -ErrorAction Stop
    return [pscustomobject]@{Data=$data; PayloadSha256=(Get-Sha256 $raw); CertSha256=(Get-CertHash $cert)}
  } finally { $cert.Dispose() }
}
function Get-SignedPayload([string]$EnvelopePath,[string]$CertificatePath,[int]$MaxPayload=524288) {
  Assert-NoReparse $EnvelopePath
  return Get-SignedPayloadBytes ([IO.File]::ReadAllBytes($EnvelopePath)) $CertificatePath $MaxPayload
}
function New-SignedEnvelope($Payload,[Security.Cryptography.X509Certificates.X509Certificate2]$Cert) {
  $raw=$script:Utf8.GetBytes((ConvertTo-Json -InputObject $Payload -Depth 20 -Compress))
  $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Cert)
  if ($null -eq $rsa) { throw 'CLIENT_SIGNING_KEY_NOT_ACCESSIBLE' }
  try { $sig=$rsa.SignData($raw,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1) }
  finally { $rsa.Dispose() }
  return [ordered]@{schema=1;payload_base64=[Convert]::ToBase64String($raw);signature_base64=[Convert]::ToBase64String($sig)}
}
function Set-ExactAcl([string]$Path,[string[]]$ExtraSids=@(),[string]$Right='ReadAndExecute') {
  Assert-NoReparse $Path
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $acl=if($item.PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $acl.SetAccessRuleProtection($true,$false)
  $admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $acl.SetOwner($admin)
  $inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  foreach($sid in @('S-1-5-18','S-1-5-32-544')+$ExtraSids) {
    $rights=if($sid -in @('S-1-5-18','S-1-5-32-544')){'FullControl'}else{$Right}
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),
      [Security.AccessControl.FileSystemRights]$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-ExactAcl([string]$Path,[string[]]$AllowedSids) {
  $a=Get-Acl -LiteralPath $Path
  if (-not $a.AreAccessRulesProtected) { throw ('ACL_INHERITANCE_OPEN: '+$Path) }
  foreach($ace in $a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $ace.IdentityReference.Value -notin $AllowedSids){
      throw ('UNEXPECTED_ACCESS_RIGHT: '+$Path+' '+$ace.IdentityReference.Value)
    }
  }
}
function Assert-Props($InputObject,[string[]]$Required,[string[]]$Optional=@()) {
  foreach($p in $Required) {if(-not $InputObject.PSObject.Properties[$p]){throw ('MISSING_'+$p)}}
  foreach($p in $InputObject.PSObject.Properties){if($p.Name -cnotin ($Required+$Optional)){throw ('UNEXPECTED_'+$p.Name)}}
}
function Test-IsUuid([string]$v) { return $v -cmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' }
function Read-Settings {return Read-JsonFile (Join-Path $script:BridgeRoot 'settings.json') 32768}
function Read-Trust {return Read-JsonFile (Join-Path $script:BridgeRoot 'trust\clients.json') 32768}
function Remove-Secrets([string]$Text,[int]$Maximum=400) {
  if(-not $Text){return ''}
  $value=$Text -replace '[\x00-\x1f\x7f]',' '
  $value=$value -replace '(?i)(password|secret|bearer|token|apikey|api_key)\s*[:=]\s*\S+','$1=[REDACTED]'
  $value=$value -replace '(?i)sk-[A-Za-z0-9_-]{12,}','[REDACTED]'
  if($value.Length -gt $Maximum) {return $value.Substring(0,$Maximum)+'[TRUNCATED]'}
  return $value
}
