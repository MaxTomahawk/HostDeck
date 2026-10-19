param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^refs/remotes/origin/.+')]
    [string] $HostRef,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^refs/remotes/upstream/.+')]
    [string] $UpstreamRef,

    [ValidateRange(1, 500)]
    [int] $CommitLimit = 100
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Git([string[]] $Arguments) {
    $output = @(& git @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $($Arguments[0])" }
    return $output
}

function Resolve-VerifiedRemoteRef([string] $Ref, [string] $RemotePrefix) {
    if (-not $Ref.StartsWith($RemotePrefix, [StringComparison]::Ordinal)) { throw 'Reference is outside the required remote namespace.' }
    & git show-ref --verify --quiet $Ref
    if ($LASTEXITCODE -ne 0) { throw "Reference is not present locally: $Ref" }
    $resolved = (Invoke-Git @('rev-parse', '--verify', '--end-of-options', "$Ref^{commit}") | Select-Object -First 1).Trim()
    if ($resolved -notmatch '^[0-9a-fA-F]{40,64}$') { throw 'Reference did not resolve to a commit.' }
    return $resolved.ToLowerInvariant()
}

$hostCommit = Resolve-VerifiedRemoteRef $HostRef 'refs/remotes/origin/'
$upstreamCommit = Resolve-VerifiedRemoteRef $UpstreamRef 'refs/remotes/upstream/'
$mergeBaseLines = @(Invoke-Git @('merge-base', $hostCommit, $upstreamCommit))
if ($mergeBaseLines.Count -eq 0) { throw 'The selected commits have no common ancestor; comparison is unavailable.' }
$mergeBase = $mergeBaseLines[0].Trim().ToLowerInvariant()
$counts = (Invoke-Git @('rev-list', '--left-right', '--count', "$hostCommit...$upstreamCommit") | Select-Object -First 1).Trim() -split '\s+'
if ($counts.Count -ne 2) { throw 'Git returned an invalid divergence count.' }
$hostOnly = [int]$counts[0]
$upstreamOnly = [int]$counts[1]

$hostLog = [object[]]@(Invoke-Git @('rev-list', "--max-count=$CommitLimit", $hostCommit, "^$mergeBase", '--') | ForEach-Object { $_.Trim().ToLowerInvariant() })
$upstreamLog = [object[]]@(Invoke-Git @('rev-list', "--max-count=$CommitLimit", $upstreamCommit, "^$mergeBase", '--') | ForEach-Object { $_.Trim().ToLowerInvariant() })
$pathLines = @(Invoke-Git @('diff', '--name-status', '--no-renames', $mergeBase, $upstreamCommit, '--'))
$paths = @($pathLines | Where-Object { $_ } | ForEach-Object {
    $parts = $_ -split "`t", 2
    if ($parts.Count -eq 2) { [pscustomobject]@{ status = $parts[0]; path = $parts[1] } }
})

[pscustomobject]@{
    mode = 'read-only local refs; no fetch or merge performed'
    hostRef = $HostRef
    hostCommit = $hostCommit
    upstreamRef = $UpstreamRef
    upstreamCommit = $upstreamCommit
    mergeBase = $mergeBase
    hostOnlyCommitCount = $hostOnly
    upstreamOnlyCommitCount = $upstreamOnly
    hostOnlyCommitIds = $hostLog
    upstreamOnlyCommitIds = $upstreamLog
    commitListLimit = $CommitLimit
    commitListsMayBeTruncated = ($hostOnly -gt $CommitLimit -or $upstreamOnly -gt $CommitLimit)
    upstreamChangedPathsFromMergeBase = $paths
} | ConvertTo-Json -Depth 5
