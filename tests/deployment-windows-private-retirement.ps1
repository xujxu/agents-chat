$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize retirement fixture'
$root = Join-Path $parent "agents-private-retirement-$([guid]::NewGuid())"
$directory = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
try {
    $file = Join-Path $root 'receipt.json'
    $published = [Deployment.WindowsPrivateFile]::Publish($file, '{"phase":"complete"}')
    try {
        $identity = $published.CaptureIdentity()
        $sha256 = $published.Sha256
        $bytes = $published.ByteLength
    } finally { $published.Dispose() }
    $retirement = [Deployment.WindowsPrivateFile]::RetainForRetirement(
        $file, $sha256, $identity.Dev, $identity.Ino, $bytes)
    try {
        $retirement.Check()
        $retirement.Delete()
        Assert (-not (Test-Path -LiteralPath $file)) 'Original private file survived retirement'
    } finally { $retirement.Dispose() }
    Write-Output 'PASS: original private file is retired through its checked native handle'
} finally {
    $directory.Dispose()
    Remove-Item -LiteralPath $root -Recurse -Force
}
