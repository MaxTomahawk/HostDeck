param(
    [Parameter(Mandatory)] [string] $AgentRuntimeDirectory,
    [Parameter(Mandatory)] [string] $NodeExecutable,
    [Parameter(Mandatory)] [string] $PackageDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime = (Resolve-Path -LiteralPath $AgentRuntimeDirectory).Path
$node = (Resolve-Path -LiteralPath $NodeExecutable).Path
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
New-Item -ItemType Directory -Path (Join-Path $package 'licenses') | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor/LICENSE') -Destination (Join-Path $package 'licenses/WindowsCommander.LICENSE')
Copy-Item -LiteralPath (Join-Path $runtime 'LICENSE') -Destination (Join-Path $package 'licenses/DesktopCommander.LICENSE')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'licenses/Node.LICENSE') -Destination (Join-Path $package 'licenses/Node.LICENSE')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'licenses/node-runtime.json') -Destination (Join-Path $package 'licenses/node-runtime.json')
$files = @(Get-ChildItem -LiteralPath $package -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ path = $_.FullName.Substring($package.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
@{ schema = 1; files = $files } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $package 'manifest.json') -Encoding utf8
Write-Output (Join-Path $package 'manifest.json')
