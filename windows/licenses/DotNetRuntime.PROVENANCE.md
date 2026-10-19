# .NET runtime license packaging

`New-HostDeckPackage.ps1` reads `includedFrameworks` from each self-contained
publish output. It requires the .NET and Windows Desktop runtime versions to
match across the three executables, then copies the matching official
`Microsoft.NETCore.App.Runtime.win-x64` and
`Microsoft.WindowsDesktop.App.Runtime.win-x64` NuGet-cache license files into
the package's `licenses/dotnet/` directory. The .NET package contributes its
MIT license and third-party notices; Windows Desktop contributes its MIT
license. The generated `provenance.json` records each exact package version,
official repository commit and NuGet package SHA-512 value.

Packaging fails closed if publish metadata is absent, versions disagree, a
matching package/license/notice is missing, or package metadata does not
identify the expected official .NET repository and MIT license. The builder
does not download licenses or infer a version from the SDK. Review the emitted
license files and provenance with each release package.
