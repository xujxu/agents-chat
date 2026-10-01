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
