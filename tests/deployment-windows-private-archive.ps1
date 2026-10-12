$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/deployment/WindowsPrivateFile.cs')
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-chat-private-archive-$([guid]::NewGuid())"
$source = Join-Path $root 'recovery-lock'
$target = Join-Path $root 'cold-policy-archive'
$occupied = Join-Path $root 'occupied'
$held = $null
function Assert-Refused([scriptblock]$Action) {
    $refused = $false
    try { & $Action } catch { $refused = $true }
    if (-not $refused) { throw 'Unsafe private journal archival was accepted.' }
}
try {
    [Deployment.WindowsPrivateFile]::CreateDirectory($root).Dispose()
    [Deployment.WindowsPrivateFile]::CreateDirectory($source).Dispose()
    [Deployment.WindowsPrivateFile]::CreateDirectory($occupied).Dispose()
    $record = [Deployment.WindowsPrivateFile]::Publish((Join-Path $source 'owner.json'), '{"original":true}')
    try { $recordHash = $record.Sha256 } finally { $record.Dispose() }
    [Deployment.WindowsPrivateFile]::Publish((Join-Path $occupied 'sentinel.json'), '{"occupied":true}').Dispose()
    $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($source)
    try {
        $identity = $directory.CaptureIdentity()
        $security = $directory.SecurityDescriptor
    } finally { $directory.Dispose() }
    Assert-Refused {
        [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement($source, $identity.Dev, '0').Dispose()
    }
    $held = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement($source, $identity.Dev, $identity.Ino)
    Assert-Refused { $held.ArchiveTo((Join-Path $occupied 'foreign-parent')) }
    Assert-Refused { $held.ArchiveTo($source) }
    Assert-Refused { $held.ArchiveTo($occupied) }
    $held.Check()
    $held.ArchiveTo($target)
    $held.Check()
    $held.Dispose()
    $held = $null
    if (Test-Path -LiteralPath $source) { throw 'Archived original directory still occupies its active name.' }
    $directory = [Deployment.WindowsPrivateFile]::OpenDirectory($target)
    try {
        $after = $directory.CaptureIdentity()
        if ($after.Dev -cne $identity.Dev -or $after.Ino -cne $identity.Ino -or
            $directory.SecurityDescriptor -cne $security) {
            throw 'Private journal archival changed its original directory identity or security.'
        }
    } finally { $directory.Dispose() }
    $record = [Deployment.WindowsPrivateFile]::Open((Join-Path $target 'owner.json'), $recordHash)
    try {
        if ($record.ReadText() -cne '{"original":true}') { throw 'Original journal bytes changed during archival.' }
    } finally { $record.Dispose() }
    if ((Get-Content -LiteralPath (Join-Path $occupied 'sentinel.json') -Raw) -cne '{"occupied":true}') {
        throw 'Private journal archival overwrote an existing destination.'
    }
    Write-Output 'PASS: native handle-bound private journal archival preserves original inode, bytes and security without overwriting or crossing parents'
} finally {
    if ($held) { $held.Dispose() }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
