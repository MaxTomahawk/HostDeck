# Build as normal user before administrative registration. .NET SDK 10.0 must be locally installed.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$proj=Join-Path $PSScriptRoot '..\runner\PrivilegedJobRunner.csproj'
& dotnet publish $proj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $OutputDirectory
if($LASTEXITCODE -ne 0){throw 'DOTNET_PUBLISH_FAILED'}
$exe=Join-Path $OutputDirectory 'PrivilegedJobRunner.exe'
if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'PUBLISH_EXE_MISSING'}
Get-FileHash -Algorithm SHA256 -LiteralPath $exe
