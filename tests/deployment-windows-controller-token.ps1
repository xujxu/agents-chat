$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsPrivateFile.cs'),
    (Join-Path $PSScriptRoot 'WindowsControllerTokenProbe.cs'))
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize controller-token fixture parent'
$root = Join-Path $parent "agents-token-owner-$([guid]::NewGuid()) space"
$job = $null
$rootLease = $null
try {
    $rootLease = [Deployment.WindowsPrivateFile]::CreateDirectory($root)
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
    $rootLease.Check()
    $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
    $owner = [DeploymentTests.WindowsControllerTokenProbe]::Run(
        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
        (Join-Path $root 'child.ps1'), (Join-Path $root 'WindowsWorkerJob.cs'), $node, $root, $job.Name,
        $PID, [Deployment.WindowsWorkerJob]::ProcessIdentity($PID))
    Assert (@($job.Members()).Count -eq 0) 'Original token fixture Job is not empty'
    $rootLease.Check()
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
    $control = Join-Path $root 'control'
    Assert (Test-Path -LiteralPath (Join-Path $control 'lock/owner.json')) 'Missing actual private Node transaction files'
    $lock = Get-Content -LiteralPath (Join-Path $control 'lock/owner.json') -Raw | ConvertFrom-Json
    $state = Get-Content -LiteralPath (Join-Path $control 'state.json') -Raw | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath (Join-Path $control 'worker-engine/manifest.json') -Raw | ConvertFrom-Json
    $writer = Get-Content -LiteralPath (Join-Path $root 'node-root.json') -Raw | ConvertFrom-Json
    Assert ($lock.pid -eq $writer.pid -and $state.operationId -ceq $lock.operationId -and
        $state.phase -ceq 'copying' -and $manifest.operationId -ceq $lock.operationId) 'Private Node transaction identity changed'
    $journals = @(Get-ChildItem -LiteralPath $control -Filter 'worker-*.ndjson')
    Assert ($journals.Count -eq 1) 'Missing actual private Node worker journal'
    $receipt = Get-Content -LiteralPath $journals[0].FullName -Raw | ConvertFrom-Json
    Assert ($receipt.phase -ceq 'intent' -and $receipt.owner.operationId -ceq $lock.operationId) 'Invalid private Node worker journal'
    $files = @(Get-ChildItem -LiteralPath $control -Recurse -File)
    Assert ($files.Count -eq $manifest.files.Count + 4) 'Unexpected private Node control contents'
    foreach ($directory in @((Get-Item -LiteralPath $control)) + @(Get-ChildItem -LiteralPath $control -Recurse -Directory)) {
        $lease = [Deployment.WindowsPrivateFile]::OpenDirectory($directory.FullName)
        try { $lease.Check() }
        finally { $lease.Dispose() }
    }
    foreach ($file in $files) {
        Assert ((Get-Acl -LiteralPath $file.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid.Value) `
            'Actual Node control file has an unsupported owner'
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $lease = [Deployment.WindowsPrivateFile]::Open($file.FullName, $hash)
        try { $lease.Check() }
        finally { $lease.Dispose() }
    }
    $rootLease.Check()
    Write-Output 'PASS: actual Node lock, replaced state, worker journal and complete saved engine are natively private without ACL repair'
    Write-Output "PASS: distinct child token and spawn-time Job create private Node/descendant files without ACL repair; original default owner $owner unchanged"
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
    if ($rootLease) {
        $rootLease.Dispose()
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
