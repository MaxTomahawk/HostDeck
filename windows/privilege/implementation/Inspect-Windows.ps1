# Read-only host baseline; DOES NOT elevate or change system state.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$scheduler=Get-Service -Name Schedule -ErrorAction SilentlyContinue
$hostDeck=Get-Service -Name HostDeck -ErrorAction SilentlyContinue
$cloudflared=Get-Service -Name cloudflared -ErrorAction SilentlyContinue
[pscustomobject]@{Computer=$env:COMPUTERNAME;WindowsSid=$id.User.Value;Account=$id.Name;
 WindowsVersion=[Environment]::OSVersion.VersionString;PowerShellVersion=$PSVersionTable.PSVersion.ToString();
 TaskScheduler=$(if($scheduler){[string]$scheduler.Status}else{'not-installed'});
 ExistingOldBroker=[bool](Test-Path -LiteralPath (Join-Path $env:ProgramData 'CodexBoundedAdmin'));
 NewBrokerPresent=[bool](Test-Path -LiteralPath (Join-Path $env:ProgramData 'CodexMandateBridge'));
 HostDeck=$(if($hostDeck){[string]$hostDeck.Status}else{'not-installed'});
 Cloudflared=$(if($cloudflared){[string]$cloudflared.Status}else{'not-installed'});
 Elevated=([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} |
 Format-List
