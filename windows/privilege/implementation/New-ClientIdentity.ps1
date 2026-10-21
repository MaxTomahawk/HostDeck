# Run UNELEVATED under the precise Windows SID to be authorized (Codex sandbox vs HostDeck account).
[CmdletBinding()]
param([Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$ClientId,
 [Parameter(Mandatory)][string]$PublicCertificatePath)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$who=[Security.Principal.WindowsIdentity]::GetCurrent()
$cert=New-SelfSignedCertificate -Subject "CN=CodexMandateBridge-$ClientId" -Type Custom `
 -KeyAlgorithm RSA -KeyLength 3072 -KeyUsage DigitalSignature `
 -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' `
 -Provider 'Microsoft Software Key Storage Provider' -NotAfter (Get-Date).AddYears(3)
Export-Certificate -Cert $cert -FilePath $PublicCertificatePath -Force | Out-Null
[pscustomobject]@{ClientId=$ClientId;AuthenticatedWindowsSid=$who.User.Value;CertificateThumbprint=$cert.Thumbprint;
 PublicCertificate=$PublicCertificatePath;SameSidBoundary='Every process able to use this account private key is equivalently trusted.'}
