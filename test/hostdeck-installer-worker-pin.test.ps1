# Real owned filesystem/config transitions; SCM and install ACL operations are
# deliberately mocked. This is not installed lifecycle or administrative proof.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Split-Path -Parent $PSScriptRoot
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$ownedRoot = Join-Path $temporaryParent ('hostdeck-pin-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ownedRoot | Out-Null
$passed = 0
function Assert([bool] $value, [string] $message) { if (-not $value) { throw $message } }
function Bytes([string] $path) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) }
function Make-Release([string] $directory, [string] $content) {
    $desktop = Join-Path $directory 'desktop'
    New-Item -ItemType Directory -Path $desktop -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $desktop 'HostDeck.DesktopWorker.exe'), $content)
    $hash = (Get-FileHash -LiteralPath (Join-Path $desktop 'HostDeck.DesktopWorker.exe')).Hash.ToLowerInvariant()
    @{schema=1;files=@(@{path='desktop/HostDeck.DesktopWorker.exe';sha256=$hash})} |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $directory 'manifest.json') -Encoding utf8
    return $hash
}
try {
    foreach ($scriptName in @('Install-HostDeck.ps1', 'Rollback-HostDeck.ps1')) {
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $source ('windows/install/' + $scriptName)), [ref]$tokens, [ref]$errors)
        Assert ($errors.Count -eq 0) 'Installer syntax must parse.'
        foreach ($name in @('Get-WorkerReleaseHash','Get-WorkerConfigState','Set-WorkerConfigHash','Restore-WorkerConfig')) {
            $definition = @($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false) | Where-Object Name -eq $name)
            Assert ($definition.Count -eq 1) 'Required production helper missing.'
            . ([scriptblock]::Create($definition[0].Extent.Text))
        }
        foreach ($bom in @($false,$true)) {
            $root = Join-Path $ownedRoot ($scriptName + '-' + $bom)
            $current = Join-Path $root 'current'
            $previous = Join-Path $root 'previous'
            $stage = Join-Path $root 'stage'
            $oldHash = Make-Release $current 'old owned executable fixture'
            $priorHash = Make-Release $previous 'prior owned executable fixture'
            $newHash = Make-Release $stage 'new owned executable fixture'
            $facadeConfig = Join-Path $root 'facade.json'
            $config = [ordered]@{desktop_worker=(Join-Path $current 'desktop/HostDeck.DesktopWorker.exe');
                desktop_worker_sha256=$oldHash;unchanged=@{unicode='é 中文';nested=@(1,2,3);enabled=$false}}
            $text = $config | ConvertTo-Json -Depth 4
            $encoding = [Text.UTF8Encoding]::new($bom)
            [IO.File]::WriteAllText($facadeConfig,$text,$encoding)
            # Model the protected installed config, not inherited Temp ACLs:
            # ReplaceFile may canonicalize their auto-inheritance flag.
            $fixtureAcl = Get-Acl -LiteralPath $facadeConfig
            $fixtureAcl.SetAccessRuleProtection($true, $true)
            Set-Acl -LiteralPath $facadeConfig -AclObject $fixtureAcl
            $originalBytes = Bytes $facadeConfig
            $originalAcl = (Get-Acl -LiteralPath $facadeConfig).Sddl
            $original = Get-WorkerConfigState $facadeConfig $root
            Assert ($original.Hash -eq (Get-WorkerReleaseHash $current)) 'Original pin must match the release.'
            $backup = Set-WorkerConfigHash $facadeConfig $original $newHash
            [byte[]]$expected = @($encoding.GetPreamble()) + @($encoding.GetBytes($text.Replace($oldHash,$newHash)))
            Assert ((Bytes $facadeConfig) -eq [Convert]::ToBase64String($expected)) 'Only the worker hash may change, including BOM and Unicode preservation.'
            Assert ((Get-Acl -LiteralPath $facadeConfig).Sddl -eq $originalAcl) 'Replacement must preserve original file ACL.'
            Restore-WorkerConfig $facadeConfig $backup $original
            Assert ((Bytes $facadeConfig) -eq $originalBytes) 'Restore must recover original bytes.'
            Assert ((Get-Acl -LiteralPath $facadeConfig).Sddl -eq $originalAcl) 'Restore must preserve file ACL.'
            Assert ($null -eq (Set-WorkerConfigHash $facadeConfig $original $oldHash)) 'Identical hash must not rewrite config.'
            [IO.File]::AppendAllText($facadeConfig,' ')
            $refused = $false
            try { Set-WorkerConfigHash $facadeConfig $original $newHash | Out-Null } catch { $refused = $_.Exception.Message -eq 'Protected facade config changed during release transaction.' }
            Assert $refused 'Concurrent config change must refuse replacement.'
            [IO.File]::WriteAllBytes($facadeConfig,$original.Bytes)

            # Execute the actual production transition/catch block against these
            # owned directories. No administrative entrypoint is dot-sourced.
            $transaction = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
            Assert ($transaction.Count -eq 1) 'Expected one top-level release transaction.'
            $existing = [pscustomobject]@{}
            $existing | Add-Member ScriptMethod WaitForStatus {param($status,$timeout)}
            $serviceConfig = Join-Path $root 'service-config.json'
            $enrollmentDirectory = Join-Path $root 'enrollment'
            $recoveryMarker = Join-Path $root 'absent-recovery-marker.json'
            $EnrolledUserSid = 'S-1-5-21-1-2-3-1001'; $deviceId = 'owned-fixture'
            $workerOriginal = $original; $originalWorker = $original
            $workerConfigBackup = $null; $configBackup = $null
            $newWorkerHash = $newHash; $rollbackWorkerHash = $priorHash
            $movedOld = $false; $installedNew = $false; $archivedPrevious = $null
            $movedCurrent = $false; $movedPrevious = $false; $stopped = $false
            $failed = Join-Path $root 'rolled-back-owned'
            $script:starts = 0
            function Stop-Service { [CmdletBinding()] param([string]$Name) }
            function Get-Service { [CmdletBinding()] param([string]$Name) return $existing }
            function Set-ExactAcl { param($path,$profile,$recursive) }
            function sc.exe { $global:LASTEXITCODE = 0 }
            function Start-Service {
                [CmdletBinding()] param([string]$Name)
                $script:starts++
                Assert ((Get-WorkerConfigState $facadeConfig $root).Hash -eq (Get-WorkerReleaseHash $current)) 'Every service start must see a coherent current worker and pin.'
                if ($script:starts -eq 1) { throw 'INJECTED_SERVICE_START_FAILURE' }
                Assert ((Bytes $facadeConfig) -eq $originalBytes) 'Recovery restart must follow exact original config restoration.'
            }
            $caught = $false
            try { . ([scriptblock]::Create($transaction[0].Extent.Text)) }
            catch { $caught = $_.Exception.Message -eq 'INJECTED_SERVICE_START_FAILURE' }
            Assert $caught 'Injected failure must be reported.'
            Assert ($script:starts -eq 2) 'Failure path must attempt recovery restart exactly once.'
            Assert ((Get-WorkerReleaseHash $current) -eq $oldHash) 'Failure must restore original current release.'
            Assert ((Bytes $facadeConfig) -eq $originalBytes) 'Failure must restore exact original config.'
            Assert ((Get-WorkerReleaseHash $previous) -eq $priorHash) 'Failure must retain the original previous release.'
            $passed++
        }
    }
    # Exercise the production Rollback-HostDeck Verify-Release helper without
    # invoking the protected installer, SCM or any installed HostDeck paths.
    $rollbackTokens = $null; $rollbackErrors = $null
    $rollbackAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $source 'windows/install/Rollback-HostDeck.ps1'),
        [ref]$rollbackTokens, [ref]$rollbackErrors)
    Assert ($rollbackErrors.Count -eq 0) 'Rollback script must parse.'
    foreach ($name in @('Assert-NoReparse', 'Verify-Release')) {
        $definition = @($rollbackAst.FindAll({
            param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]
        }, $false) | Where-Object Name -eq $name)
        Assert ($definition.Count -eq 1) 'Expected exactly one production release validator helper.'
        . ([scriptblock]::Create($definition[0].Extent.Text))
    }

    $releaseFixture = Join-Path $ownedRoot 'rollback-release-integrity'
    $requiredFiles = @(
        'service/HostDeck.Lifecycle.exe', 'desktop/HostDeck.DesktopWorker.exe',
        'tray/HostDeck.Tray.exe', 'agent/node.exe',
        'agent/dist/hostdeck/main.js', 'agent/ui/newtree/index.html',
        'licenses/Node.LICENSE'
    )
    $releaseEntries = @(
        foreach ($relative in $requiredFiles) {
            $filePath = Join-Path $releaseFixture $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $filePath) -Force | Out-Null
            [IO.File]::WriteAllText($filePath, 'Owned fixture: ' + $relative)
            @{path=$relative; sha256=(Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
    )
    $releaseManifest = Join-Path $releaseFixture 'manifest.json'
    @{schema=1; files=@($releaseEntries)} | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $releaseManifest -Encoding utf8
    Verify-Release $releaseFixture
    $passed++

    # A syntactically valid, hash-consistent manifest must not pass rollback
    # if it omits an essential agent/UI/license component still on disk.
    foreach ($missing in @('agent/node.exe', 'agent/dist/hostdeck/main.js',
            'agent/ui/newtree/index.html', 'licenses/Node.LICENSE')) {
        @{schema=1; files=@($releaseEntries | Where-Object { $_.path -cne $missing })} |
            ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $releaseManifest -Encoding utf8
        $refused = $false
        try { Verify-Release $releaseFixture }
        catch { $refused = $_.Exception.Message -eq 'Incomplete previous release.' }
        Assert $refused ('Rollback must reject missing essential release entry: ' + $missing)
        $passed++
    }
    # Real NTFS DACL oracle for the actual installer Prepare-StateAcl helper.
    # The production installer entrypoint, SYSTEM/Admin owner and SCM are NOT run.
    $installerTokens = $null; $installerErrors = $null
    $installerAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $source 'windows/install/Install-HostDeck.ps1'),
        [ref]$installerTokens, [ref]$installerErrors)
    Assert ($installerErrors.Count -eq 0) 'Install script must parse.'
    foreach ($name in @('Assert-NoReparsePath','Assert-NoReparseTree','Prepare-StateAcl')) {
        $definition = @($installerAst.FindAll({
            param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]
        }, $false) | Where-Object Name -eq $name)
        Assert ($definition.Count -eq 1) 'Expected exactly one production state ACL helper.'
        . ([scriptblock]::Create($definition[0].Extent.Text))
    }
    $stateFixture = Join-Path $ownedRoot 'upgrade-state-acl'
    $indexFixture = Join-Path $stateFixture 'fulltext-index'
    New-Item -ItemType Directory -Path $indexFixture -Force | Out-Null
    $indexFile = Join-Path $indexFixture 'owned.writerlock.sqlite'
    [IO.File]::WriteAllText($indexFile, 'disposable-index-content')
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $indexAcl = Get-Acl -LiteralPath $indexFixture
    $indexAcl.SetAccessRuleProtection($true, $false)
    $indexRights = [Security.AccessControl.FileSystemRights](
        [int][Security.AccessControl.FileSystemRights]::Modify -bor
        [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
    $indexAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $userSid, $indexRights, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $indexFixture -AclObject $indexAcl
    $snapshot = @{}
    foreach ($entry in @($stateFixture, $indexFixture, $indexFile)) {
        $snapshot[$entry] = (Get-Acl -LiteralPath $entry).Sddl
    }
    $contentBefore = Bytes $indexFile
    $script:stateAclCalls = 0
    function Set-ExactAcl {
        param($path, $profile, $recursive)
        $script:stateAclCalls++
        Assert ($path -eq $stateFixture -and $profile -eq 'state' -and $recursive) 'Fresh state ACL setup must remain scoped and recursive.'
    }
    Prepare-StateAcl $stateFixture $true
    Assert ($script:stateAclCalls -eq 0) 'Upgrade must not normalize existing state ACLs.'
    foreach ($entry in @($stateFixture, $indexFixture, $indexFile)) {
        Assert ((Get-Acl -LiteralPath $entry).Sddl -ceq $snapshot[$entry]) 'Upgrade must preserve every existing ACL byte-for-byte at SDDL level.'
    }
    Assert ((Bytes $indexFile) -eq $contentBefore) 'Upgrade must preserve existing index bytes.'
    $actualIndexAcl = Get-Acl -LiteralPath $indexFixture
    $allowed = 0
    foreach ($ace in $actualIndexAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
        if ($ace.IdentityReference.Value -eq $userSid.Value -and
            $ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
            $allowed = $allowed -bor [int]$ace.FileSystemRights
        }
    }
    Assert (($allowed -band 0x46) -eq 0x46) 'Existing index ACL must retain add-file, add-subdirectory and delete-child.'
    Prepare-StateAcl $stateFixture $false
    Assert ($script:stateAclCalls -eq 1) 'Fresh install must still request protected recursive state ACL setup.'
    Write-Output "Windows installer worker-pin, release-integrity and mocked-SCM cases: $passed PASS. Installed lifecycle NOT_RUN."
    Write-Output 'Real owned NTFS state/index ACL preservation and fresh-install dispatch: 2 PASS. Installed upgrade NOT_RUN.'
} finally {
    $resolved = [IO.Path]::GetFullPath($ownedRoot)
    if ($resolved -ne $ownedRoot -or (Split-Path -Parent $resolved).TrimEnd('\') -ne $temporaryParent.TrimEnd('\') -or
        (Split-Path -Leaf $resolved) -notmatch '^hostdeck-pin-test-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path.' }
    foreach ($entry in @(Get-Item -LiteralPath $resolved) + @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refuse fixture cleanup through a reparse point.' }
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
