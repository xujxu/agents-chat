$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helpers = Join-Path $repository 'scripts/deployment'
$supervisor = Join-Path $helpers 'windows-command-supervisor.ps1'
Assert (Test-Path -LiteralPath $supervisor -PathType Leaf) 'Missing captured Windows command supervisor'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs' | ForEach-Object { Join-Path $helpers $_ })
$node = & node -p "require('node:fs').realpathSync.native(process.execPath)"
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize supervisor fixture Node'
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize supervisor fixture parent'
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$root = Join-Path $parent "agents-supervisor-$([guid]::NewGuid())"
try {
    [Deployment.WindowsPrivateFile]::CreateDirectory($root).Dispose()
    $source = Join-Path $root 'source'
    $project = Join-Path $root 'project'
    foreach ($directory in @($source, (Join-Path $source 'scripts'), (Join-Path $source 'scripts/deployment'),
        (Join-Path $source 'lib'), (Join-Path $source 'lib/workflow'), $project)) {
        [Deployment.WindowsPrivateFile]::CreateDirectory($directory).Dispose()
    }
    foreach ($file in Get-ChildItem -LiteralPath $helpers -File) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $source "scripts/deployment/$($file.Name)")
    }
    Copy-Item -LiteralPath (Join-Path $repository 'lib/workflow/workflowSchema.mjs') `
        -Destination (Join-Path $source 'lib/workflow/workflowSchema.mjs')
    Copy-Item -LiteralPath (Join-Path $repository 'scripts/update.ps1') -Destination (Join-Path $source 'scripts/update.ps1')
    $entry = @'
import fs from 'node:fs';
import path from 'node:path';
import { processIdentity } from './process-identity.mjs';
const control = process.argv[4];
const scenario = process.argv.at(-1) === '1800'
  ? process.argv[5].replace('Agents-Supervisor-', '') : process.argv.at(-1);
const identity = await processIdentity(process.pid);
if (!identity) throw new Error('Missing original command process identity');
fs.writeFileSync(path.join(control, 'actor.json'), JSON.stringify({ pid: process.pid, identity, scenario }));
const prior = scenario === 'prior';
console.log(JSON.stringify({
  status: prior ? 'failed' : scenario === 'current' ? 'already-current' : 'accepted',
  closeoutRequired: !['current', 'invalid'].includes(scenario),
  operationId: '11111111-1111-4111-8111-111111111111',
  recoveryEngine: 'a'.repeat(64), code: prior ? 'DEPLOYMENT_TEST_FAILURE' : undefined,
  message: prior ? 'Fixture update failed; prior runtime recovered.' : undefined,
}));
process.exitCode = scenario === 'exit-invalid' ? 2 : prior ? 1 : 0;
'@
    $finalizer = @'
import fs from 'node:fs';
import path from 'node:path';
import { processIdentity } from './process-identity.mjs';
const [control, , operationId, , , phase] = process.argv.slice(2);
const actor = JSON.parse(fs.readFileSync(path.join(control, 'actor.json')));
if (await processIdentity(actor.pid) === actor.identity) throw new Error('Original command actor is still alive');
fs.writeFileSync(path.join(control, 'closeout-attempted'), phase);
if (actor.scenario === 'closeout-failed') {
  console.log(JSON.stringify({ status: 'failed', code: 'DEPLOYMENT_TEST_CLOSEOUT_FAILURE' }));
  process.exitCode = 1;
} else {
  fs.writeFileSync(path.join(control, 'finalized'), phase);
  console.log(JSON.stringify({ status: 'completed', operationId, phase }));
}
'@
    [IO.File]::WriteAllText((Join-Path $source 'scripts/deployment/windows-command-entry.mjs'), $entry)
    [IO.File]::WriteAllText((Join-Path $source 'scripts/deployment/windows-command-finalize-entry.mjs'), $finalizer)
    foreach ($scenario in @('accepted', 'prior', 'current', 'invalid', 'closeout-failed', 'exit-invalid')) {
        $case = Join-Path $root $scenario
        $control = Join-Path $case 'control'
        foreach ($directory in @($case, $control)) { [Deployment.WindowsPrivateFile]::CreateDirectory($directory).Dispose() }
        $arguments = ConvertTo-Json -InputObject @($scenario) -Compress
        $text = & $pwsh -NoProfile -NonInteractive -File $supervisor -Operation update -Source $source `
            -Project $project -Control $control -Directory (Join-Path $case 'capture') -TemporaryDirectory $case `
            -TaskName Agents-Supervisor-Fixture -Node $node -PowerShell $pwsh -Git (Get-Command git).Source `
            -NpmCli (Join-Path (Split-Path $node) 'node_modules/npm/bin/npm-cli.js') -ArgumentsJson $arguments
        $code = $LASTEXITCODE
        $result = ($text -join "`n") | ConvertFrom-Json
        $expectedCode = if ($scenario -in @('accepted', 'current')) { 0 } else { 1 }
        Assert ($code -eq $expectedCode) "Supervisor lost original $scenario exit status"
        Assert ((Test-Path -LiteralPath (Join-Path $case 'capture')) -eq ($expectedCode -ne 0)) `
            'Supervisor must retire successful captures and retain failed command evidence'
        if ($scenario -in @('accepted', 'prior')) {
            $phase = if ($scenario -eq 'prior') { 'prior-runtime-restored' } else { 'accepted' }
            $status = if ($scenario -eq 'prior') { 'failed' } else { 'accepted' }
            Assert ($result.status -ceq $status -and $result.closeoutStatus -ceq 'completed' -and
                -not $result.closeoutRequired) 'Supervisor replaced the original outcome with finalizer success'
            Assert ([IO.File]::ReadAllText((Join-Path $control 'finalized')) -ceq $phase) 'Supervisor finalized the wrong phase'
        } else {
            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'finalized'))) 'Supervisor finalized an unqualified result'
            Assert ((Test-Path -LiteralPath (Join-Path $control 'closeout-attempted')) -eq ($scenario -eq 'closeout-failed')) `
                'Supervisor attempted closeout without a qualified original result'
            if ($scenario -eq 'current') { Assert ($result.status -ceq 'already-current') 'Supervisor lost no-op result' }
            else { Assert ($result.code -ceq 'DEPLOYMENT_WINDOWS_SUPERVISOR_FAILED') 'Invalid result was not explicitly refused' }
        }
    }
    foreach ($scenario in @('accepted', 'prior', 'current')) {
        $publicProject = Join-Path $root "public-$scenario"
        [Deployment.WindowsPrivateFile]::CreateDirectory($publicProject).Dispose()
        $publicControl = Join-Path $root ".public-$scenario.deployment"
        $publicControllers = Join-Path $root ".public-$scenario.deployment-controllers"
        Assert (-not (Test-Path -LiteralPath $publicControl)) 'Public supervisor fixture starts without control'
        $text = & $pwsh -NoProfile -NonInteractive -File (Join-Path $source 'scripts/update.ps1') `
            -ProjectDir $publicProject -TaskName "Agents-Supervisor-$scenario" -SkipGitPull -Json
        $code = $LASTEXITCODE
        $result = ($text -join "`n") | ConvertFrom-Json
        $expectedCode = if ($scenario -eq 'prior') { 1 } else { 0 }
        Assert ($code -eq $expectedCode) "Public supervisor lost original $scenario exit status: $($text -join '`n')"
        $private = [Deployment.WindowsPrivateFile]::OpenDirectory($publicControl)
        $private.Dispose()
        $private = [Deployment.WindowsPrivateFile]::OpenDirectory($publicControllers)
        $private.Dispose()
        $remaining = @(Get-ChildItem -LiteralPath $publicControllers -Force)
        Assert ($remaining.Count -eq $expectedCode) 'Public supervisor did not clean successful captures or retain failed capture'
        if ($scenario -eq 'current') {
            Assert ($result.status -ceq 'already-current' -and -not (Test-Path -LiteralPath (Join-Path $publicControl 'finalized'))) `
                'Public no-op unexpectedly invoked finalization'
        } else {
            Assert ($result.closeoutStatus -ceq 'completed' -and -not $result.closeoutRequired) `
                'Public supervisor did not return completed finalization'
            Assert ($result.status -ceq $(if ($scenario -eq 'prior') { 'failed' } else { 'accepted' })) `
                'Public wrapper replaced recovered failure with success'
        }
    }
    Write-Output 'PASS: private supervisor settles original actors, preserves recovered failure exit status and skips unqualified closeout'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
