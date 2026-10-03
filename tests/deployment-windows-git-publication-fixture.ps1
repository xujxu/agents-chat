param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$SavedIndex,
    [ValidateSet('replace', 'absent', 'stage-identity', 'target-identity', 'stage-bytes',
        'target-bytes', 'stage-alias', 'target-alias', 'unexpected-target',
        'stage-policy', 'target-policy', 'stage-attributes', 'target-attributes')]
    [string]$Scenario = 'replace'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path @(
    (Join-Path $PSScriptRoot '../scripts/deployment/WindowsPrivateFile.cs'),
    (Join-Path $PSScriptRoot '../scripts/deployment/WindowsPrivateFile.SourceSecurity.cs'))
if ('PublishSourceFile' -cnotin [Deployment.WindowsPrivateFile].GetMethods().Name) {
    throw 'Native Git lockfile publication is not implemented.'
}
$root = [IO.Path]::Combine($Project, '.git')
$target = [IO.Path]::Combine($root, 'index')
$stage = $target + '.lock'
$original = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index', 'file')
$originalHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$bytes = [IO.File]::ReadAllBytes($SavedIndex)
$lease = [Deployment.WindowsPrivateFile]::CreateSourceFile($root, 'index.lock')
try {
    $writer = [IO.FileStream]::new($stage, [IO.FileMode]::Open,
        [IO.FileAccess]::Write, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $writer.Write($bytes, 0, $bytes.Length)
        $writer.Flush($true)
    } finally { $writer.Dispose() }
    $private = $lease.Finish($bytes.Length)
} finally { $lease.Dispose() }
[Deployment.WindowsPrivateFile]::RestoreSourceSecurity(
    $root, 'index.lock', 'file', $private.Dev, $private.Ino, $original.SecurityDescriptor, $original.Attributes)
$staged = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index.lock', 'file')
$stageHash = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedStage = $staged
$expectedTarget = $original
$expectedStageHash = $stageHash
$expectedTargetHash = $originalHash
switch ($Scenario) {
    'absent' {
        [Deployment.WindowsPrivateFile]::RemoveUnaliasedSourceFile($root, 'index', $original.Dev, $original.Ino)
        $expectedTarget = $null
        $expectedTargetHash = $null
    }
    'stage-identity' { $expectedStage = $original }
    'target-identity' { $expectedTarget = $staged }
    'stage-bytes' { $expectedStageHash = '0' * 64 }
    'target-bytes' { $expectedTargetHash = '0' * 64 }
    'stage-alias' { New-Item -ItemType HardLink -Path (Join-Path $Project 'outside-alias') -Target $stage | Out-Null }
    'target-alias' { New-Item -ItemType HardLink -Path (Join-Path $Project 'outside-alias') -Target $target | Out-Null }
    'unexpected-target' { $expectedTarget = $null; $expectedTargetHash = $null }
    { $_ -cin @('stage-policy', 'target-policy') } {
        $changed = if ($Scenario -ceq 'stage-policy') { $stage } else { $target }
        $acl = Get-Acl -LiteralPath $changed
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
            [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
        Set-Acl -LiteralPath $changed -AclObject $acl
    }
    { $_ -cin @('stage-attributes', 'target-attributes') } {
        $changed = if ($Scenario -ceq 'stage-attributes') { $stage } else { $target }
        [IO.File]::SetAttributes($changed, [IO.File]::GetAttributes($changed) -bor [IO.FileAttributes]::Hidden)
    }
}
$witnessStage = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index.lock', 'file')
$witnessTarget = if ($Scenario -cne 'absent') {
    [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index', 'file')
} else { $null }
$refused = $false
try {
    [Deployment.WindowsPrivateFile]::PublishSourceFile(
        $root, 'index', $expectedStage, $expectedTarget, $expectedStageHash, $expectedTargetHash)
} catch {
    if ($Scenario -cin @('replace', 'absent')) { throw }
    if ($_.Exception.ToString() -notmatch 'changed|differ|unaliased|absent') { throw }
    $refused = $true
}
if ($Scenario -cnotin @('replace', 'absent')) {
    if (-not $refused) { throw 'Conflicting Git publication was not refused.' }
    $after = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index', 'file')
    $afterStage = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index.lock', 'file')
    if ($after.Dev -cne $witnessTarget.Dev -or $after.Ino -cne $witnessTarget.Ino -or
        $after.SecurityDescriptor -cne $witnessTarget.SecurityDescriptor -or $after.Attributes -ne $witnessTarget.Attributes -or
        $afterStage.Dev -cne $witnessStage.Dev -or $afterStage.Ino -cne $witnessStage.Ino -or
        $afterStage.SecurityDescriptor -cne $witnessStage.SecurityDescriptor -or
        $afterStage.Attributes -ne $witnessStage.Attributes -or
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $originalHash -or
        (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant() -cne $stageHash) {
        throw 'Refused Git publication changed original evidence.'
    }
} else {
    if (Test-Path -LiteralPath $stage) { throw 'Published Git lockfile name remains.' }
    $after = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($root, 'index', 'file')
    if ($after.Dev -cne $staged.Dev -or $after.Ino -cne $staged.Ino -or
        $after.SecurityDescriptor -cne $staged.SecurityDescriptor -or $after.Attributes -ne $staged.Attributes -or
        (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $stageHash) {
        throw 'Atomic Git publication did not preserve staged identity, bytes and security.'
    }
}
[Console]::Out.WriteLine('accepted')
