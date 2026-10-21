param(
    [Parameter(Mandatory)] [string] $AgentRuntimeDirectory,
    [Parameter(Mandatory)] [string] $NodeExecutable,
    [Parameter(Mandatory)] [string] $PackageDirectory,
    [string] $BrokerRunnerExecutable,
    [ValidatePattern('^[a-fA-F0-9]{64}$')] [string] $ExpectedBrokerRunnerSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert-NoReparsePath([string] $path) {
    $part = [IO.Path]::GetFullPath($path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $entry = Get-Item -LiteralPath $part -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in package source: $part" }
        }
        $parent = Split-Path -Parent $part
        if (-not $parent -or $parent -eq $part) { break }
        $part = $parent
    }
}
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime = (Resolve-Path -LiteralPath $AgentRuntimeDirectory).Path
$node = (Resolve-Path -LiteralPath $NodeExecutable).Path
if ([bool]$BrokerRunnerExecutable -ne [bool]$ExpectedBrokerRunnerSha256) {
    throw 'BrokerRunnerExecutable and ExpectedBrokerRunnerSha256 must be provided together.'
}
$brokerRoot = Join-Path $sourceRoot 'privilege'
$brokerImplementation = Join-Path $brokerRoot 'implementation'
$brokerManifestPath = Join-Path $brokerImplementation 'source-sha256.json'
$brokerProject = Join-Path $brokerRoot 'runner/PrivilegedJobRunner.csproj'
foreach ($path in @($brokerImplementation, $brokerManifestPath, $brokerProject,
        (Join-Path $brokerRoot 'runner/Program.cs'), (Join-Path $brokerRoot 'README.md'),
        (Join-Path $brokerRoot 'LICENSES/PROVENANCE.md'),
        (Join-Path $brokerRoot 'LICENSES/PACKAGE_MIT.txt'),
        (Join-Path $brokerRoot 'LICENSES/HostDeck_and_DesktopCommander_MIT.txt'))) {
    Assert-NoReparsePath $path
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing broker source: $path" }
}
$brokerManifest = Get-Content -LiteralPath $brokerManifestPath -Raw | ConvertFrom-Json
if ($brokerManifest.schema -ne 1 -or @($brokerManifest.files).Count -lt 1) { throw 'Invalid broker source manifest.' }
$scriptNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $brokerManifest.files) {
    $name = [string]$entry.name
    if ($name -cnotmatch '^[A-Za-z0-9._-]+\.ps1$' -or
        [string]$entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not $scriptNames.Add($name)) {
        throw 'Unsafe broker source manifest entry.'
    }
    $scriptPath = Join-Path $brokerImplementation $name
    Assert-NoReparsePath $scriptPath
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash -ne [string]$entry.sha256) {
        throw "Broker source does not match manifest: $name"
    }
}
$actualScripts = @(Get-ChildItem -LiteralPath $brokerImplementation -Filter '*.ps1' -File -Force)
if ($actualScripts.Count -ne $scriptNames.Count -or @($actualScripts | Where-Object { -not $scriptNames.Contains($_.Name) }).Count) {
    throw 'Broker source manifest does not enumerate every script.'
}
$brokerManifestSha256 = (Get-FileHash -LiteralPath $brokerManifestPath -Algorithm SHA256).Hash
if ($BrokerRunnerExecutable) {
    Assert-NoReparsePath $BrokerRunnerExecutable
    $brokerRunner = (Resolve-Path -LiteralPath $BrokerRunnerExecutable).Path
    if (-not (Test-Path -LiteralPath $brokerRunner -PathType Leaf) -or
        (Get-FileHash -LiteralPath $brokerRunner -Algorithm SHA256).Hash -ne $ExpectedBrokerRunnerSha256) {
        throw 'Pinned broker runner hash mismatch.'
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'dist/hostdeck/main.js') -PathType Leaf)) { throw 'Missing facade entrypoint.' }
foreach ($required in @('package.json', 'package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $required) -PathType Leaf)) { throw "Missing $required." }
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Missing Node executable.' }
$nodeRuntime = Get-Content -LiteralPath (Join-Path $sourceRoot 'licenses/node-runtime.json') -Raw | ConvertFrom-Json
$actualNodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -ne $nodeRuntime.version) { throw "Node executable version must match licensed runtime $($nodeRuntime.version)." }
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'licenses/Node.LICENSE') -PathType Leaf)) { throw 'Missing Node runtime license.' }
$package = [IO.Path]::GetFullPath($PackageDirectory)
if (Test-Path -LiteralPath $package) { throw 'PackageDirectory must be new.' }
New-Item -ItemType Directory -Path $package | Out-Null
foreach ($component in @('HostDeck.DesktopWorker', 'HostDeck.Lifecycle', 'HostDeck.Tray')) {
    $directory = switch ($component) {
        'HostDeck.DesktopWorker' { 'desktop' }
        'HostDeck.Lifecycle' { 'service' }
        'HostDeck.Tray' { 'tray' }
    }
    $project = Join-Path $sourceRoot "$component/$component.csproj"
    & dotnet publish $project -c Release -r win-x64 --self-contained true -p:DebugType=None -p:DebugSymbols=false -o (Join-Path $package $directory) -v:q
    if ($LASTEXITCODE -ne 0) { throw "Publish failed: $component" }
}
# Read the exact framework versions emitted by self-contained publish; never guess
# a runtime version from the installed SDK or copy notices from a mismatched pack.
$frameworkVersions = @{}
foreach ($directory in @('desktop', 'service', 'tray')) {
    $runtimeConfigs = @(Get-ChildItem -LiteralPath (Join-Path $package $directory) -Filter '*.runtimeconfig.json' -File)
    if ($runtimeConfigs.Count -ne 1) { throw "Expected one self-contained runtime config in $directory." }
    $runtimeOptions = (Get-Content -LiteralPath $runtimeConfigs[0].FullName -Raw | ConvertFrom-Json).runtimeOptions
    $included = @($runtimeOptions.includedFrameworks)
    if (-not $included.Count) { throw "Publish output in $directory does not identify its included runtime frameworks." }
    $current = @{}
    foreach ($framework in $included) {
        if ($framework.name -notin @('Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App') -or $framework.version -notmatch '^\d+\.\d+\.\d+$') {
            throw "Unexpected included runtime framework metadata in $directory."
        }
        if ($current.ContainsKey($framework.name)) { throw "Duplicate runtime framework metadata in $directory." }
        $current[$framework.name] = $framework.version
    }
    if (-not $current.ContainsKey('Microsoft.NETCore.App')) { throw "Expected Microsoft.NETCore.App in $directory." }
    $needsDesktop = $directory -in @('desktop', 'tray')
    if ($needsDesktop -ne $current.ContainsKey('Microsoft.WindowsDesktop.App')) {
        throw "Unexpected Microsoft.WindowsDesktop.App inclusion in $directory."
    }
    foreach ($frameworkName in $current.Keys) {
        if ($frameworkVersions.ContainsKey($frameworkName) -and $frameworkVersions[$frameworkName] -ne $current[$frameworkName]) {
            throw "Published $frameworkName runtime versions differ between packaged executables."
        }
        $frameworkVersions[$frameworkName] = $current[$frameworkName]
    }
}
$nugetCacheLine = (& dotnet nuget locals global-packages --list)
if ($LASTEXITCODE -ne 0 -or $nugetCacheLine -notmatch '^global-packages:\s*(.+)$') { throw 'Cannot locate the installed NuGet package cache.' }
$nugetCache = [IO.Path]::GetFullPath($Matches[1].Trim())
$dotnetLicenseDirectory = Join-Path $package 'licenses/dotnet'
New-Item -ItemType Directory -Path $dotnetLicenseDirectory -Force | Out-Null
$dotnetPackages = @(
    @{ id = 'Microsoft.NETCore.App.Runtime.win-x64'; version = $frameworkVersions['Microsoft.NETCore.App']; license = 'LICENSE.TXT'; destination = 'Microsoft.NETCore.App.LICENSE.TXT'; notices = 'THIRD-PARTY-NOTICES.TXT' },
    @{ id = 'Microsoft.WindowsDesktop.App.Runtime.win-x64'; version = $frameworkVersions['Microsoft.WindowsDesktop.App']; license = 'LICENSE'; destination = 'Microsoft.WindowsDesktop.App.LICENSE'; notices = $null }
)
$dotnetProvenance = @()
foreach ($entry in $dotnetPackages) {
    $packageCache = Join-Path $nugetCache (Join-Path $entry.id.ToLowerInvariant() $entry.version)
    $nuspecFile = Join-Path $packageCache ($entry.id.ToLowerInvariant() + '.nuspec')
    $hashFile = Join-Path $packageCache ($entry.id.ToLowerInvariant() + '.' + $entry.version + '.nupkg.sha512')
    foreach ($requiredFile in @($nuspecFile, $hashFile, (Join-Path $packageCache $entry.license)) + $(if ($entry.notices) { @(Join-Path $packageCache $entry.notices) } else { @() })) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) { throw "Missing official .NET license source file for $($entry.id) $($entry.version)." }
    }
    [xml]$nuspec = Get-Content -LiteralPath $nuspecFile -Raw
    $metadata = $nuspec.package.metadata
    if ($metadata.id -ne $entry.id -or $metadata.version -ne $entry.version -or $metadata.license.type -ne 'expression' -or $metadata.license.'#text' -ne 'MIT' -or
        $metadata.repository.url -ne 'https://github.com/dotnet/dotnet' -or $metadata.repository.commit -notmatch '^[0-9a-f]{40}$') {
        throw "Unrecognized .NET license package provenance for $($entry.id) $($entry.version)."
    }
    Copy-Item -LiteralPath (Join-Path $packageCache $entry.license) -Destination (Join-Path $dotnetLicenseDirectory $entry.destination)
    if ($entry.notices) { Copy-Item -LiteralPath (Join-Path $packageCache $entry.notices) -Destination (Join-Path $dotnetLicenseDirectory 'THIRD-PARTY-NOTICES.TXT') }
    $dotnetProvenance += @{ package = $entry.id; version = $entry.version; license = 'MIT'; repository = $metadata.repository.url; commit = $metadata.repository.commit; nupkgSha512 = (Get-Content -LiteralPath $hashFile -Raw).Trim() }
}
@{ schema = 1; frameworks = $frameworkVersions; packages = $dotnetProvenance } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dotnetLicenseDirectory 'provenance.json') -Encoding utf8
New-Item -ItemType Directory -Path (Join-Path $package 'agent/dist') -Force | Out-Null
Copy-Item -Path (Join-Path $runtime 'dist/*') -Destination (Join-Path $package 'agent/dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $runtime 'package.json') -Destination (Join-Path $package 'agent/package.json')
Copy-Item -LiteralPath (Join-Path $runtime 'package-lock.json') -Destination (Join-Path $package 'agent/package-lock.json')
New-Item -ItemType Directory -Path (Join-Path $package 'agent/vendor') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $runtime 'vendor/telemetry-contract') -Destination (Join-Path $package 'agent/vendor/telemetry-contract') -Recurse
& npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix (Join-Path $package 'agent')
if ($LASTEXITCODE -ne 0) { throw 'Agent production dependency install failed.' }
$module = [IO.Path]::GetFullPath((Join-Path $package 'agent/node_modules/@desktop-commander/telemetry-contract'))
$vendor = [IO.Path]::GetFullPath((Join-Path $package 'agent/vendor/telemetry-contract'))
if (-not $module.StartsWith($package.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    -not $vendor.StartsWith($package.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Local dependency escaped the package.'
}
$moduleEntry = Get-Item -LiteralPath $module -Force
if (($moduleEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($moduleEntry.LinkType -ne 'Junction' -or -not [IO.Path]::IsPathFullyQualified([string]$moduleEntry.Target) -or
        -not [IO.Path]::GetFullPath([string]$moduleEntry.Target).Equals($vendor, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unexpected local dependency junction target.'
    }
    # Directory.Delete without recursive=true removes the junction itself,
    # never the package's vendor target.
    [IO.Directory]::Delete($module)
    New-Item -ItemType Directory -Path $module | Out-Null
    Get-ChildItem -LiteralPath $vendor -Force | Copy-Item -Destination $module -Recurse -Force
}
if ((Get-Item -LiteralPath $module -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Local dependency remains a reparse point.'
}
Copy-Item -LiteralPath $node -Destination (Join-Path $package 'agent/node.exe')
$ui = Join-Path $runtime 'ui/newtree'
if (-not (Test-Path -LiteralPath (Join-Path $ui 'index.html') -PathType Leaf)) { throw 'Missing management UI.' }
New-Item -ItemType Directory -Path (Join-Path $package 'agent/ui/newtree') -Force | Out-Null
Copy-Item -Path (Join-Path $ui '*') -Destination (Join-Path $package 'agent/ui/newtree') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $package 'installer') | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*.ps1') -Destination (Join-Path $package 'installer')
New-Item -ItemType Directory -Path (Join-Path $package 'licenses') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor/LICENSE') -Destination (Join-Path $package 'licenses/WindowsCommander.LICENSE')
Copy-Item -LiteralPath (Join-Path $runtime 'LICENSE') -Destination (Join-Path $package 'licenses/DesktopCommander.LICENSE')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'licenses/Node.LICENSE') -Destination (Join-Path $package 'licenses/Node.LICENSE')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'licenses/node-runtime.json') -Destination (Join-Path $package 'licenses/node-runtime.json')
$brokerPackage = Join-Path $package 'installer/privilege'
foreach ($directory in @($brokerPackage, (Join-Path $brokerPackage 'implementation'),
        (Join-Path $brokerPackage 'runner'), (Join-Path $brokerPackage 'LICENSES'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
foreach ($file in @(Get-ChildItem -LiteralPath $brokerImplementation -File -Force)) {
    Assert-NoReparsePath $file.FullName
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $brokerPackage ('implementation/' + $file.Name))
}
foreach ($name in @('PROVENANCE.md', 'PACKAGE_MIT.txt', 'HostDeck_and_DesktopCommander_MIT.txt')) {
    Copy-Item -LiteralPath (Join-Path $brokerRoot ('LICENSES/' + $name)) -Destination (Join-Path $brokerPackage ('LICENSES/' + $name))
}
Copy-Item -LiteralPath (Join-Path $brokerRoot 'README.md') -Destination (Join-Path $brokerPackage 'README.md')
Copy-Item -LiteralPath $brokerProject -Destination (Join-Path $brokerPackage 'runner/PrivilegedJobRunner.csproj')
Copy-Item -LiteralPath (Join-Path $brokerRoot 'runner/Program.cs') -Destination (Join-Path $brokerPackage 'runner/Program.cs')
if ($BrokerRunnerExecutable) {
    Copy-Item -LiteralPath $brokerRunner -Destination (Join-Path $brokerPackage 'runner/PrivilegedJobRunner.exe')
} else {
    & dotnet publish $brokerProject -c Release -r win-x64 --self-contained true `
        -p:DebugType=None -p:DebugSymbols=false -o (Join-Path $brokerPackage 'runner') -v:q
    if ($LASTEXITCODE -ne 0) { throw 'Broker runner publish failed.' }
}
$packagedRunner = Join-Path $brokerPackage 'runner/PrivilegedJobRunner.exe'
if (-not (Test-Path -LiteralPath $packagedRunner -PathType Leaf)) { throw 'Broker runner missing from package.' }
$packagedRunnerSha256 = (Get-FileHash -LiteralPath $packagedRunner -Algorithm SHA256).Hash
if ($BrokerRunnerExecutable -and $packagedRunnerSha256 -ne $ExpectedBrokerRunnerSha256) {
    throw 'Copied broker runner hash mismatch.'
}
if ((Get-FileHash -LiteralPath (Join-Path $brokerPackage 'implementation/source-sha256.json') -Algorithm SHA256).Hash -ne $brokerManifestSha256) {
    throw 'Copied broker source manifest hash mismatch.'
}
foreach ($entry in $brokerManifest.files) {
    $copied = Join-Path $brokerPackage ('implementation/' + [string]$entry.name)
    if ((Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash -ne [string]$entry.sha256) {
        throw "Copied broker script hash mismatch: $($entry.name)"
    }
}
@{ schema = 1; source_manifest_sha256 = $brokerManifestSha256; runner_sha256 = $packagedRunnerSha256;
    script_count = @($brokerManifest.files).Count; registration = 'separate-explicit-install-only' } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $brokerPackage 'package-provenance.json') -Encoding utf8
$files = @(Get-ChildItem -LiteralPath $package -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ path = $_.FullName.Substring($package.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
@{ schema = 1; files = $files } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding utf8
Write-Output (Join-Path $package 'manifest.json')
