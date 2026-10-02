$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsPrivateFile.cs'),
    (Join-Path $PSScriptRoot 'WindowsControllerTokenProbe.cs'))
$node = (Get-Command node).Source
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-token-owner-$([guid]::NewGuid()) space"
$job = $null
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $root = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $root
    Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize controller-token fixture'
    Copy-Item -LiteralPath (Join-Path $source 'WindowsWorkerJob.cs') -Destination (Join-Path $root 'WindowsWorkerJob.cs')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deployment-windows-controller-token-child.ps1') -Destination (Join-Path $root 'child.ps1')
    @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const child = process.argv[3] === 'child';
fs.writeFileSync(path.join(root, child ? 'node-child.json' : 'node-root.json'), JSON.stringify({ pid: process.pid }));
if (!child) {
  const result = require('node:child_process').spawnSync(process.execPath, [__filename, root, 'child'],
    { timeout: 10000, stdio: 'pipe', env: process.env });
  assert.equal(result.status, 0);
}
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
    & (Join-Path $PSScriptRoot 'deployment-windows-private-control.ps1') -Control $root
    $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
    $owner = [DeploymentTests.WindowsControllerTokenProbe]::Run(
        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
        (Join-Path $root 'child.ps1'), (Join-Path $root 'WindowsWorkerJob.cs'), $node, $root, $job.Name,
        $PID, [Deployment.WindowsWorkerJob]::ProcessIdentity($PID))
    Assert (@($job.Members()).Count -eq 0) 'Original token fixture Job is not empty'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($name in @('node-root.json', 'node-child.json')) {
        $file = Join-Path $root $name
        Assert ((Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid.Value) `
            'Node-created file did not inherit the copied token default owner'
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
        try { Assert (($retained.ReadText() | ConvertFrom-Json).pid -gt 0) 'Invalid native owner writer result' }
        finally { $retained.Dispose() }
    }
    Write-Output "PASS: copied primary token creates private Node/descendant files without ACL repair; original default owner $owner unchanged"
} finally {
    if ($job) {
        $job.Terminate()
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (@($job.Members()).Count) {
            Assert ([DateTime]::UtcNow -lt $deadline) 'Original token fixture Job did not settle'
            Start-Sleep -Milliseconds 100
        }
        $job.Dispose()
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
