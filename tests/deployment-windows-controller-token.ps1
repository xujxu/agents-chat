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
    @{ source = [IO.Path]::GetFullPath($source); pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $root 'fixture.json') -Encoding utf8
    @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const child = process.argv[3] === 'child';
async function writeControl() {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
  const source = fs.realpathSync.native(fixture.source);
  const load = name => import(require('node:url').pathToFileURL(path.join(source, name)).href);
  const [{ acquireLock, writeState }, { createWorkerJournal }, { saveWorkerEngine, verifyWorkerEngine }] =
    await Promise.all([load('state.mjs'), load('worker-journal.mjs'), load('saved-worker-engine.mjs')]);
  const project = path.join(root, 'project');
  const control = path.join(root, 'control');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(control, { mode: 0o700 });
  const { randomUUID } = require('node:crypto');
  const operationId = randomUUID();
  const lock = await acquireLock(control, { project, operationId, pwsh: fixture.pwsh });
  let state = {
    version: 1, operationId, project, operation: 'update', phase: 'preflight', previousPhase: null,
    sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), backupId: null,
    priorRuntime: 'running', runtimeIdentity: randomUUID(), startedAt: lock.createdAt,
    updatedAt: new Date().toISOString(), errorCode: null,
  };
  await writeState(control, state);
  for (const phase of ['stopped', 'copying']) {
    state = { ...state, previousPhase: state.phase, phase, updatedAt: new Date().toISOString() };
    await writeState(control, state);
  }
  const owner = { project, operationId, workerId: randomUUID(), controllerIdentity: lock.processIdentity };
  const journal = await createWorkerJournal(control, owner);
  try { await journal.record({ version: 1, owner, phase: 'intent', domain: null }); }
  finally { await journal.close(); }
  const saved = await saveWorkerEngine({ source, control, project, operationId });
  assert.deepEqual(await verifyWorkerEngine({ control, project, operationId, manifestSha256: saved.manifestSha256 }), saved);
}
fs.writeFileSync(path.join(root, child ? 'node-child.json' : 'node-root.json'), JSON.stringify({ pid: process.pid }));
if (!child) {
  const result = require('node:child_process').spawnSync(process.execPath, [__filename, root, 'child'],
    { timeout: 10000, stdio: 'pipe', env: process.env });
  assert.equal(result.status, 0);
  writeControl().catch(error => { console.error(error); process.exitCode = 1; });
}
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
    $rootLease.Check()
    $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
    try {
        $owner = [DeploymentTests.WindowsControllerTokenProbe]::Run(
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
            (Join-Path $root 'child.ps1'), (Join-Path $root 'WindowsWorkerJob.cs'), $node, $root, $job.Name,
            $PID, [Deployment.WindowsWorkerJob]::ProcessIdentity($PID))
    } catch {
        $diagnostic = Join-Path $root 'writer-error.txt'
        if ((Test-Path -LiteralPath $diagnostic) -and (Get-Item -LiteralPath $diagnostic).Length -le 32768) {
            Write-Output ([IO.File]::ReadAllText($diagnostic))
        }
        throw
    }
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
    Assert ($files.Count -eq $manifest.files.Count + 5) 'Unexpected private Node control contents'
    Assert ((Get-Item -LiteralPath (Join-Path $control 'windows-admission.lock')).Length -eq 0) 'Native admission gate changed'
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
