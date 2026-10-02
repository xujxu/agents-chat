$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/deployment/WindowsPrivateFile.cs')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Refuses([scriptblock]$Action, [string]$Expected) {
    $observed = $null
    try { & $Action | Out-Null }
    catch { $observed = $_.Exception.GetBaseException().Message }
    Assert ($observed -ceq $Expected) "Unexpected private configuration refusal: $observed"
}
function Refuses-ExistingPublication([string]$File, [string]$Expected) {
    $collision = $false
    try { [Deployment.WindowsPrivateFile]::Publish($File, '{"phase":"changed"}').Dispose() }
    catch {
        $failure = $_.Exception.GetBaseException()
        $code = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $failure.HResult -band 0xffff }
        $collision = $code -in @(80, 183)
    }
    Assert ($collision -and [IO.File]::ReadAllText($File) -ceq $Expected) 'Private publication overwrote existing evidence'
}
function Set-FixtureOwner([string]$File, [Security.Principal.SecurityIdentifier]$Sid) {
    $security = Get-Acl -LiteralPath $File
    Write-Output "Fixture initial owner SID: $($security.GetOwner([Security.Principal.SecurityIdentifier]).Value)"
    $security.SetOwner($Sid)
    Set-Acl -LiteralPath $File -AclObject $security
}
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-private-file-$([guid]::NewGuid()) space"
$retained = $null
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $root = node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $root
    if ($LASTEXITCODE -ne 0) { throw 'Cannot canonicalize the private configuration fixture directory' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $root
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl',
            'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    $publishedPath = Join-Path $root 'published.json'
    $published = [Deployment.WindowsPrivateFile]::Publish($publishedPath, '{"phase":"intent"}')
    try {
        Assert ($published.ReadText() -ceq '{"phase":"intent"}' -and $published.Sha256 -ceq
            (Get-FileHash -LiteralPath $publishedPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'Published private receipt lost its exact bytes'
        Refuses-ExistingPublication $publishedPath '{"phase":"intent"}'
        $published.Check()
        $sharing = $false
        try { [IO.File]::WriteAllText($publishedPath, 'changed') }
        catch { $sharing = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32 }
        Assert $sharing 'Private publication did not retain its original read-only handle'
    } finally { $published.Dispose() }
    Refuses-ExistingPublication $publishedPath '{"phase":"intent"}'
    $before = @(Get-ChildItem -LiteralPath $root).Count
    Refuses { [Deployment.WindowsPrivateFile]::Publish((Join-Path $root 'oversized.json'), ('x' * 1048577)) } 'Private publication exceeds the size limit.'
    $encoding = $false
    try { [Deployment.WindowsPrivateFile]::Publish((Join-Path $root 'invalid.json'), [string][char]0xd800).Dispose() }
    catch { $encoding = $_.Exception.GetBaseException() -is [Text.EncoderFallbackException] }
    Assert ($encoding -and @(Get-ChildItem -LiteralPath $root).Count -eq $before) 'Invalid publication content created filesystem artifacts'
    $publicDirectory = Join-Path $root 'public'
    New-Item -ItemType Directory -Path $publicDirectory | Out-Null
    $publicAcl = Get-Acl -LiteralPath $publicDirectory
    $publicAcl.SetOwner($sid)
    $publicAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $publicDirectory -AclObject $publicAcl
    Refuses { [Deployment.WindowsPrivateFile]::Publish((Join-Path $publicDirectory 'intent.json'), '{}') } 'Private configuration permissions are unsupported.'
    Assert (@(Get-ChildItem -LiteralPath $publicDirectory).Count -eq 0) 'Private publication wrote into an unsupported directory'
    $createdDirectory = Join-Path $publicDirectory 'native-private'
    $parentSecurity = (Get-Acl -LiteralPath $publicDirectory).Sddl
    $directory = [Deployment.WindowsPrivateFile]::CreateDirectory($createdDirectory)
    try {
        $createdSecurity = Get-Acl -LiteralPath $createdDirectory
        Assert ($createdSecurity.AreAccessRulesProtected -and
            $createdSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid.Value) `
            'Native directory was not created with protected current-user ownership'
        Assert ((Get-Acl -LiteralPath $publicDirectory).Sddl -ceq $parentSecurity) 'Native creation altered parent permissions'
        $directory.Check()
        $collision = $false
        try { [Deployment.WindowsPrivateFile]::CreateDirectory($createdDirectory).Dispose() }
        catch {
            $failure = $_.Exception.GetBaseException()
            $collision = $failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 183
        }
        Assert ($collision -and (Get-Acl -LiteralPath $createdDirectory).Sddl -ceq $createdSecurity.Sddl) `
            'Native directory creation adopted or changed an existing directory'
        $sharing = $false
        try { [IO.Directory]::Move($createdDirectory, (Join-Path $publicDirectory 'moved')) }
        catch { $sharing = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32 }
        Assert $sharing 'Retained native directory allowed replacement'
        $receipt = [Deployment.WindowsPrivateFile]::Publish((Join-Path $createdDirectory 'intent.json'), '{"private":true}')
        try { Assert ($receipt.ReadText() -ceq '{"private":true}') 'New private directory cannot publish private evidence' }
        finally { $receipt.Dispose() }
        $directory.Check()
        $reopened = [Deployment.WindowsPrivateFile]::OpenDirectory($createdDirectory)
        try { $reopened.Check() }
        finally { $reopened.Dispose() }
        $changedSecurity = Get-Acl -LiteralPath $createdDirectory
        $changedSecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
        Set-Acl -LiteralPath $createdDirectory -AclObject $changedSecurity
        Refuses { $directory.Check() } 'Private publication directory changed.'
        Refuses { [Deployment.WindowsPrivateFile]::OpenDirectory($createdDirectory) } 'Private configuration permissions are unsupported.'
        Set-Acl -LiteralPath $createdDirectory -AclObject $createdSecurity
    } finally { $directory.Dispose() }
    $disposedDirectory = $false
    try { $directory.Check() }
    catch { $disposedDirectory = $_.Exception.GetBaseException() -is [ObjectDisposedException] }
    Assert $disposedDirectory 'Disposed directory authority was accepted'
    Remove-Item -LiteralPath $createdDirectory -Recurse -Force
    Refuses { [Deployment.WindowsPrivateFile]::OpenDirectory($publicDirectory) } 'Private configuration permissions are unsupported.'
    Write-Output 'PASS: native private directory creation needs no ACL repair, refuses reuse and retains original identity'
    $publicationLink = Join-Path $root 'publication-link'
    New-Item -ItemType Junction -Path $publicationLink -Target $publicDirectory | Out-Null
    Refuses { [Deployment.WindowsPrivateFile]::Publish((Join-Path $publicationLink 'intent.json'), '{}') } 'Private publication directory is redirected.'
    Refuses { [Deployment.WindowsPrivateFile]::OpenDirectory($publicationLink) } 'Private publication directory is redirected.'
    Refuses { [Deployment.WindowsPrivateFile]::CreateDirectory((Join-Path $publicationLink 'refused')) } 'Private publication directory is redirected.'
    Assert (@(Get-ChildItem -LiteralPath $publicDirectory).Count -eq 0) 'Redirected publication admitted a write'
    Remove-Item -LiteralPath $publicationLink -Force
    Write-Output 'PASS: atomic private publication retains exact evidence, refuses replacement and validates content and parent before writing'
    $file = Join-Path $root 'runtime.json'
    $text = '{"version":1,"literal":"%n $HOME \" space"}'
    [IO.File]::WriteAllText($file, $text, [Text.UTF8Encoding]::new($false))
    Set-FixtureOwner $file $sid
    $digest = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($file, $digest)
    Assert ($retained.ReadText() -ceq $text -and $retained.Sha256 -ceq $digest) 'Private file content or digest changed'
    $retained.Check()
    foreach ($action in @(
        { [IO.File]::WriteAllText($file, 'changed') },
        { [IO.File]::Move($file, (Join-Path $root 'renamed.json')) }
    )) {
        $sharingRefusal = $false
        try { & $action }
        catch { $sharingRefusal = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32 }
        Assert $sharingRefusal 'Original retained configuration allowed concurrent writing or replacement'
        $retained.Check()
    }
    Write-Output 'PASS: original private configuration handle binds exact bytes and blocks writing/replacement'
    $retained.Dispose()
    $retained = $null
    Refuses { [Deployment.WindowsPrivateFile]::Open($file, ('0' * 64)) } 'Private configuration digest differs.'

    $original = Get-Acl -LiteralPath $file
    $retained = [Deployment.WindowsPrivateFile]::Open($file, $digest)
    $public = Get-Acl -LiteralPath $file
    $public.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $public
    Refuses { $retained.Check() } 'Retained private configuration changed.'
    $retained.Dispose()
    $retained = $null
    Refuses { [Deployment.WindowsPrivateFile]::Open($file, $digest) } 'Private configuration permissions are unsupported.'
    Set-Acl -LiteralPath $file -AclObject $original
    Write-Output 'PASS: foreign-reader permissions are refused and retained ACL changes are detected'

    $hard = Join-Path $root 'hard.json'
    New-Item -ItemType HardLink -Path $hard -Target $file | Out-Null
    Refuses { [Deployment.WindowsPrivateFile]::Open($file, $digest) } 'Private configuration file type or links are unsupported.'
    Remove-Item -LiteralPath $hard -Force
    $symbolic = Join-Path $root 'symbolic.json'
    New-Item -ItemType SymbolicLink -Path $symbolic -Target $file | Out-Null
    Refuses { [Deployment.WindowsPrivateFile]::Open($symbolic, $digest) } 'Private configuration file type or links are unsupported.'
    $junction = Join-Path $root 'redirected'
    $target = Join-Path $root 'actual'
    New-Item -ItemType Directory -Path $target | Out-Null
    Copy-Item -LiteralPath $file -Destination (Join-Path $target 'runtime.json')
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    Refuses { [Deployment.WindowsPrivateFile]::Open((Join-Path $junction 'runtime.json'), $digest) } 'Private configuration path is redirected.'
    Write-Output 'PASS: hard links, final symbolic links and redirected ancestors cannot supply private configuration'

    $large = Join-Path $root 'large.json'
    [IO.File]::WriteAllBytes($large, [byte[]]::new(1024 * 1024 + 1))
    Refuses { [Deployment.WindowsPrivateFile]::Open($large, ('0' * 64)) } 'Private configuration file exceeds the size limit.'
    $invalid = Join-Path $root 'invalid.json'
    [IO.File]::WriteAllBytes($invalid, [byte[]]@(0xc3, 0x28))
    Set-FixtureOwner $invalid $sid
    $invalidDigest = (Get-FileHash -LiteralPath $invalid -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($invalid, $invalidDigest)
    $invalidUtf8 = $false
    try { $retained.ReadText() | Out-Null }
    catch { $invalidUtf8 = $_.Exception.GetBaseException() -is [Text.DecoderFallbackException] }
    Assert $invalidUtf8 'Invalid UTF-8 configuration was silently decoded'
    $retained.Dispose()
    $disposed = $false
    try { $retained.Check() }
    catch {
        $failure = $_.Exception.GetBaseException()
        $disposed = $failure -is [ObjectDisposedException] -and $failure.ObjectName -eq 'Private configuration'
    }
    Assert $disposed 'Disposed configuration handle was accepted'
    $retained = $null
    Write-Output 'PASS: configuration size, encoding and retained-handle lifetime are bounded'
} finally {
    if ($retained) { $retained.Dispose() }
    Remove-Item -LiteralPath $root -Recurse -Force
}
