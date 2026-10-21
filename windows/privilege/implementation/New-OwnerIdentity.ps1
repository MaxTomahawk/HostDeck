# Run as a DISTINCT human owner identity. A same-SID owner key cannot enforce independent approvals.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PublicCertificatePath,
 [switch]$UseSoftwareKey,[switch]$MachineStoreSoftwareKey)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if($UseSoftwareKey -and $MachineStoreSoftwareKey){throw 'CHOOSE_ONE_OWNER_KEY_MODE'}
if($MachineStoreSoftwareKey){
 $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
 if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'MACHINE_OWNER_KEY_REQUIRES_ELEVATION'}
}
$provider=if($UseSoftwareKey -or $MachineStoreSoftwareKey){'Microsoft Software Key Storage Provider'}else{'Microsoft Platform Crypto Provider'}
$store=if($MachineStoreSoftwareKey){'Cert:\LocalMachine\My'}else{'Cert:\CurrentUser\My'}
$ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$certificate=New-SelfSignedCertificate -Subject 'CN=CodexMandateBridge-IndependentOwner' `
 -Type Custom -Provider $provider -KeyAlgorithm RSA -KeyLength 3072 -KeyUsage DigitalSignature `
 -KeyExportPolicy NonExportable -CertStoreLocation $store -NotAfter (Get-Date).AddYears(3)
if($MachineStoreSoftwareKey){
 $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
 try {
  if($rsa -isnot [Security.Cryptography.RSACng] -or -not $rsa.Key.IsMachineKey -or
    $rsa.Key.Provider.Provider -cne $provider){throw 'MACHINE_OWNER_KEY_PROVIDER_INVALID'}
  $expected=[Security.AccessControl.RawSecurityDescriptor]::new('O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)')
  $sd=New-Object byte[] $expected.BinaryLength
  $expected.GetBinaryForm($sd,0)
  $options=[Security.Cryptography.CngPropertyOptions]5 # OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
  $rsa.Key.SetProperty([Security.Cryptography.CngProperty]::new('Security Descr',$sd,$options))
  $actualBytes=$rsa.Key.GetProperty('Security Descr',$options).GetValue()
  $actual=[Security.AccessControl.RawSecurityDescriptor]::new($actualBytes,0)
  if($actual.Owner.Value -cne 'S-1-5-32-544' -or
    ($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
    $actual.DiscretionaryAcl.Count -ne 2){throw 'MACHINE_OWNER_KEY_ACL_INVALID'}
  $allowed=@('S-1-5-18','S-1-5-32-544')
  # The Microsoft Software KSP expands GA to its canonical full-control mask on readback.
  $canonicalFullControlMask=[Convert]::ToInt32('D01F01FF',16)
  foreach($ace in $actual.DiscretionaryAcl){
   if($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
     $ace.SecurityIdentifier.Value -notin $allowed -or
     ($ace.AccessMask -ne 0x10000000 -and $ace.AccessMask -ne $canonicalFullControlMask)){throw 'MACHINE_OWNER_KEY_ACL_INVALID'}
  }
  if(@($actual.DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value}|Select-Object -Unique).Count -ne 2){throw 'MACHINE_OWNER_KEY_ACL_INVALID'}
 }finally{if($rsa){$rsa.Dispose()}}
 $reopened=Get-Item -LiteralPath ($store+'\'+$certificate.Thumbprint) -ErrorAction Stop
 $signer=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($reopened)
 try {
  $probe=[Text.Encoding]::ASCII.GetBytes('CodexMandateBridge owner key test')
  $signature=$signer.SignData($probe,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $public=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($reopened)
  try {if(-not $public.VerifyData($probe,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)){throw 'MACHINE_OWNER_KEY_SIGN_VERIFY_FAILED'}}
  finally{$public.Dispose()}
 }finally{if($signer){$signer.Dispose()}}
}
Export-Certificate -Cert $certificate -FilePath $PublicCertificatePath -Force | Out-Null
[pscustomobject]@{OwnerWindowsSid=$ownerSid;Thumbprint=$certificate.Thumbprint;
 PublicCertificate=$PublicCertificatePath;Provider=$provider;Store=$store;
 Warning=$(if($MachineStoreSoftwareKey){'Admin/SYSTEM-only machine key; not a separate SYSTEM-independent owner or app-exclusive identity.'}else{'Keep this private key inaccessible to enrolled clients. TPM nonexportability does not enforce per-app exclusivity.'})}
