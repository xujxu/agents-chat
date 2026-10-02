$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Refuses([scriptblock]$Action, [string]$Expected) {
    $observed = $null
    try { & $Action | Out-Null }
    catch { $observed = $_.Exception.GetBaseException().Message }
    Assert ($observed -ceq $Expected) "Unexpected private retirement refusal: $observed"
}
function Refuses-Sharing([scriptblock]$Action) {
    $code = 0
    try { & $Action | Out-Null }
    catch {
        $failure = $_.Exception.GetBaseException()
        $code = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode }
            else { $failure.HResult -band 0xffff }
    }
    Assert ($code -in @(5, 32)) "Original exclusive retirement handle allowed conflicting access: $code"
}
function Retain-Original {
    return [Deployment.WindowsPrivateFile]::RetainForRetirement(
        $file, $sha256, $identity.Dev, $identity.Ino, $bytes)
}
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize retirement fixture'
$root = Join-Path $parent "agents-private-retirement-$([guid]::NewGuid())"
$directory = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
try {
    $work = Join-Path $root 'original'
    [Deployment.WindowsPrivateFile]::CreateDirectory($work).Dispose()
    $file = Join-Path $work 'receipt.json'
    $text = '{"phase":"complete"}'
    $published = [Deployment.WindowsPrivateFile]::Publish($file, $text)
    try {
        $identity = $published.CaptureIdentity()
        $sha256 = $published.Sha256
        $bytes = $published.ByteLength
    } finally { $published.Dispose() }
    $neighbour = Join-Path $work 'neighbour.json'
    [Deployment.WindowsPrivateFile]::Publish($neighbour, '{"keep":true}').Dispose()
    Refuses {
        [Deployment.WindowsPrivateFile]::RetainForRetirement(
            $file, ('0' * 64), $identity.Dev, $identity.Ino, $bytes).Dispose()
    } 'Private configuration digest differs.'
    foreach ($changed in @(
        @(($identity.Dev + '0'), $identity.Ino, $bytes),
        @($identity.Dev, ($identity.Ino + '0'), $bytes),
        @($identity.Dev, $identity.Ino, ($bytes + 1))
    )) {
        Refuses {
            [Deployment.WindowsPrivateFile]::RetainForRetirement(
                $file, $sha256, $changed[0], $changed[1], $changed[2]).Dispose()
        } 'Original retirement file identity or length differs.'
        Assert ([IO.File]::ReadAllText($file) -ceq $text) 'Descriptor refusal changed original evidence'
    }
    $old = Join-Path $work 'old.json'
    [IO.File]::Move($file, $old)
    [Deployment.WindowsPrivateFile]::Publish($file, $text).Dispose()
    Refuses { (Retain-Original).Dispose() } 'Original retirement file identity or length differs.'
    Assert ([IO.File]::ReadAllText($file) -ceq $text -and [IO.File]::ReadAllText($old) -ceq $text) `
        'Replaced identity refusal changed either file'
    Remove-Item -LiteralPath $file
    [IO.File]::Move($old, $file)
    $proof = [Deployment.WindowsPrivateFile]::Open($file, $sha256)
    try { Refuses-Sharing { (Retain-Original).Dispose() } }
    finally { $proof.Dispose() }
    $retirement = Retain-Original
    $moved = Join-Path $root 'moved'
    try {
        $retirement.Check()
        foreach ($action in @(
            { [IO.File]::ReadAllText($file) },
            { [IO.File]::WriteAllText($file, 'changed') },
            { [IO.File]::Move($file, $old) },
            { [IO.File]::Delete($file) },
            { [IO.Directory]::Move($work, $moved) }
        )) {
            Refuses-Sharing $action
            $retirement.Check()
        }
    } finally { $retirement.Dispose() }
    Assert ([IO.File]::ReadAllText($file) -ceq $text) 'Ordinary retirement disposal deleted or changed evidence'
    [IO.Directory]::Move($work, $moved)
    [IO.Directory]::Move($moved, $work)
    $retirement = Retain-Original
    try {
        $retirement.Check()
        $retirement.Delete()
        Assert (-not (Test-Path -LiteralPath $file)) 'Original private file survived retirement'
        Assert ([IO.File]::ReadAllText($neighbour) -ceq '{"keep":true}') 'Retirement changed unrelated evidence'
        foreach ($action in @({ $retirement.Check() }, { $retirement.Delete() })) {
            $disposed = $false
            try { & $action }
            catch { $disposed = $_.Exception.GetBaseException() -is [ObjectDisposedException] }
            Assert $disposed 'Disposed retirement handle was accepted'
        }
    } finally { $retirement.Dispose() }
    Write-Output 'PASS: native retirement requires exact private identity, excludes conflicting handles and deletes only the checked original; ordinary close preserves evidence'
    $published = [Deployment.WindowsPrivateFile]::Publish($file, $text)
    try { $identity = $published.CaptureIdentity() }
    finally { $published.Dispose() }
    $acl = Get-Acl -LiteralPath $file
    $public = Get-Acl -LiteralPath $file
    $public.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $public
    $publicSddl = (Get-Acl -LiteralPath $file).Sddl
    Refuses { (Retain-Original).Dispose() } 'Private configuration permissions are unsupported.'
    Assert ((Get-Acl -LiteralPath $file).Sddl -ceq $publicSddl) 'Retirement repaired unsupported permissions'
    Set-Acl -LiteralPath $file -AclObject $acl
    $retirement = Retain-Original
    try {
        Set-Acl -LiteralPath $file -AclObject $public
        Refuses { $retirement.Delete() } 'Retained private configuration changed.'
    } finally { $retirement.Dispose() }
    Assert ([IO.File]::ReadAllText($file) -ceq $text) 'Changed permissions allowed deletion'
    Set-Acl -LiteralPath $file -AclObject $acl
    $hard = Join-Path $work 'hard.json'
    New-Item -ItemType HardLink -Path $hard -Target $file | Out-Null
    Refuses { (Retain-Original).Dispose() } 'Private configuration file type or links are unsupported.'
    Remove-Item -LiteralPath $hard
    $symbolic = Join-Path $work 'symbolic.json'
    New-Item -ItemType SymbolicLink -Path $symbolic -Target $file | Out-Null
    Refuses {
        [Deployment.WindowsPrivateFile]::RetainForRetirement(
            $symbolic, $sha256, $identity.Dev, $identity.Ino, $bytes).Dispose()
    } 'Private configuration file type or links are unsupported.'
    Remove-Item -LiteralPath $symbolic
    $junction = Join-Path $root 'redirected'
    New-Item -ItemType Junction -Path $junction -Target $work | Out-Null
    Refuses {
        [Deployment.WindowsPrivateFile]::RetainForRetirement(
            (Join-Path $junction 'receipt.json'), $sha256, $identity.Dev, $identity.Ino, $bytes).Dispose()
    } 'Private publication directory is redirected.'
    Remove-Item -LiteralPath $junction
    $parentAcl = Get-Acl -LiteralPath $work
    $publicParent = Get-Acl -LiteralPath $work
    $publicParent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    $retirement = Retain-Original
    try {
        Set-Acl -LiteralPath $work -AclObject $publicParent
        Refuses { $retirement.Delete() } 'Private publication directory changed.'
    } finally { $retirement.Dispose() }
    Refuses { (Retain-Original).Dispose() } 'Private configuration permissions are unsupported.'
    Set-Acl -LiteralPath $work -AclObject $parentAcl
    Assert ([IO.File]::ReadAllText($file) -ceq $text -and
        [IO.File]::ReadAllText($neighbour) -ceq '{"keep":true}') 'Unsafe retirement changed evidence'
    Write-Output 'PASS: native retirement refuses unsafe or changed file/parent permissions, hard links and redirected paths without repair or deletion'
} finally {
    $directory.Dispose()
    Remove-Item -LiteralPath $root -Recurse -Force
}
