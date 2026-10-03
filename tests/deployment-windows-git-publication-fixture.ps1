param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$SavedIndex,
    [ValidateSet('replace', 'absent', 'stage-identity', 'target-identity', 'stage-bytes',
        'target-bytes', 'stage-alias', 'target-alias', 'unexpected-target')]
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
    [IO.File]::WriteAllBytes($stage, $bytes)
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
}
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
    if ($after.Dev -cne $original.Dev -or $after.Ino -cne $original.Ino -or
        $after.SecurityDescriptor -cne $original.SecurityDescriptor -or $after.Attributes -ne $original.Attributes -or
        $afterStage.Dev -cne $staged.Dev -or $afterStage.Ino -cne $staged.Ino -or
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
