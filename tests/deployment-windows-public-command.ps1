$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$update = Join-Path $repository 'scripts/update.ps1'
Assert (Test-Path -LiteralPath $update -PathType Leaf) 'Missing public Windows update entry'
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-public-$([guid]::NewGuid()) space"
$missing = Join-Path $root 'absent'
try {
    $restore = Join-Path $repository 'scripts/restore.ps1'
    Assert (Test-Path -LiteralPath $restore -PathType Leaf) 'Missing public Windows restore entry'
    $text = & $pwsh -NoProfile -NonInteractive -File $restore -Help -Json -ProjectDir $missing
    Assert ($LASTEXITCODE -eq 0) 'Public restore help failed'
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'help' -and $result.message.Contains('-AcceptDataLoss')) 'Restore help omits data-loss acknowledgement'
    Assert ($result.message.Contains('already released') -and $result.message.Contains('unfinished completion') -and
        $result.message.Contains('interrupted copies with retained stopped') -and
        $result.message.Contains('inactive/reboot and legacy recovery remain unsupported')) `
        'Restore help must distinguish released recovery from unsupported earlier prefixes'
    $text = & $pwsh -NoProfile -NonInteractive -File $restore -ProjectDir $missing -Json
    Assert ($LASTEXITCODE -eq 1) 'Public restore started without acknowledgement'
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.code -ceq 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED') 'Restore acknowledgement was not explicitly required'
    $text = & $pwsh -NoProfile -NonInteractive -File $restore -ProjectDir $missing -AcceptDataLoss -TimeoutSeconds 0 -Json
    Assert ($LASTEXITCODE -eq 1) 'Public restore accepted zero stage timeout'
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'failed') 'Invalid restore timeout returned success'
    Assert (-not (Test-Path -LiteralPath $root)) 'Public restore refusal created installation files'
    foreach ($operation in @('deploy', 'update')) {
        $entry = Join-Path $repository "scripts/$operation.ps1"
        $text = & $pwsh -NoProfile -NonInteractive -File $entry -Help -Json -ProjectDir $missing
        Assert ($LASTEXITCODE -eq 0) "$operation public help failed"
        $result = ($text -join "`n") | ConvertFrom-Json
        Assert ($result.status -ceq 'help' -and $result.message.Contains('-Revision')) 'Public help is incomplete'
        Assert (-not (Test-Path -LiteralPath $root)) 'Public help created installation files'
        $unsupportedFlags = @('-NoWait', '-Verify', '-DryRun', '-RemoveTask')
        if ($operation -ceq 'update') { $unsupportedFlags += '-NoTunnel' }
        foreach ($flag in $unsupportedFlags) {
            $text = & $pwsh -NoProfile -NonInteractive -File $entry -ProjectDir $missing -Json $flag
            Assert ($LASTEXITCODE -eq 1) "Public $flag must fail before access to an absent project"
            $result = ($text -join "`n") | ConvertFrom-Json
            Assert ($result.code -ceq 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED') "Public $flag was not explicitly refused"
            Assert (-not (Test-Path -LiteralPath $root)) 'Unsupported public mode created files'
        }
        foreach ($policy in @(
            @('-NoTunnel', '-Status'), @('-NoTunnel', '-NoInstall'),
            @('-TaskLogonType', 'S4U'), @('-TaskTriggerType', 'AtStartup')
        )) {
            $text = & $pwsh -NoProfile -NonInteractive -File $entry -ProjectDir $missing -Json @policy
            Assert ($LASTEXITCODE -eq 1) 'Conflicting first policy must fail before installation access'
            $result = ($text -join "`n") | ConvertFrom-Json
            Assert ($result.code -ceq 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED') 'First policy conflict was not explicitly refused'
            Assert (-not (Test-Path -LiteralPath $root)) 'First policy conflict created installation files'
        }
    }
    New-Item -ItemType Directory -Path $root | Out-Null
    $project = Join-Path $root 'project'
    New-Item -ItemType Directory -Path $project | Out-Null
    $nodeOptions = $env:NODE_OPTIONS
    $nodePath = $env:NODE_PATH
    $originalPath = $env:PATH
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $shadow = Join-Path $root 'shadow-tools'
    New-Item -ItemType Directory -Path $shadow | Out-Null
    [IO.File]::WriteAllText((Join-Path $shadow 'node.exe'), 'This later PATH entry must never execute.')
    try {
        $env:NODE_OPTIONS = '--require=agents-public-must-not-load'
        $env:NODE_PATH = Join-Path $root 'must-not-load'
        $env:PATH = "$(Split-Path -Parent $node);$shadow;$originalPath"
        Assert (@(Get-Command node.exe -CommandType Application).Count -gt 1) 'Fixture requires multiple Node tool candidates'
        $text = & $pwsh -NoProfile -NonInteractive -File $update -ProjectDir $project -Status -Json
        $statusCode = $LASTEXITCODE
    } finally {
        $env:NODE_OPTIONS = $nodeOptions
        $env:NODE_PATH = $nodePath
        $env:PATH = $originalPath
    }
    Assert ($statusCode -eq 0) "Read-only public status failed or inherited Node hooks: $($text -join '`n')"
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'unmanaged' -and $null -eq $result.phase) 'Fresh public status was not unmanaged'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment'))) 'Status created control files'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment-controllers'))) 'Status captured controller files'
    Assert (@(Get-ChildItem -LiteralPath $project -Force).Count -eq 0) 'Status changed project files'
    $minimal = @'
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [pwsh, entry, project, git, temporary] = process.argv.slice(1);
for (const executable of [pwsh, path.join(path.dirname(pwsh), path.basename(pwsh).toUpperCase())]) {
  const child = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-File', entry,
    '-ProjectDir', executable === pwsh ? project : project.toUpperCase(), '-Status', '-Json'], {
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: [path.dirname(process.execPath), path.dirname(pwsh), path.dirname(git)].join(';'),
      TEMP: temporary, TMP: temporary,
    },
    encoding: 'utf8', timeout: 30000, maxBuffer: 32768,
  });
  assert.ifError(child.error);
  process.stderr.write(child.stderr);
  assert.equal(child.status, 0, child.stdout);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'unmanaged');
  assert.equal(result.project, require('node:fs').realpathSync.native(project));
}
'@
    $git = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
    & $node -e $minimal $pwsh $update $project $git $root
    Assert ($LASTEXITCODE -eq 0) 'Public status requires deterministic native execution without inherited PATHEXT'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment'))) 'Minimal-environment status created control files'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment-controllers'))) 'Minimal-environment status captured helpers'
    $text = & $pwsh -NoProfile -NonInteractive -File $update -ProjectDir $project -Revision invalid -Json
    Assert ($LASTEXITCODE -eq 1) 'Invalid revision was not refused'
    $result = ($text -join "`n") | ConvertFrom-Json
    Assert ($result.status -ceq 'failed') 'Invalid revision returned success'
    Assert (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 2) 'Invalid revision created control/capture files'
    $restoreWithoutGit = @'
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [pwsh, entry, project, temporary] = process.argv.slice(1);
const child = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', entry,
  '-ProjectDir', project, '-AcceptDataLoss', '-TimeoutSeconds', '60', '-Json'], {
  env: {
    SystemRoot: process.env.SystemRoot,
    PATH: [path.dirname(process.execPath), path.dirname(pwsh)].join(';'),
    TEMP: temporary, TMP: temporary,
    NODE_OPTIONS: '--require=agents-restore-must-not-load',
    NODE_PATH: path.join(temporary, 'must-not-load'),
  },
  encoding: 'utf8', timeout: 120000, maxBuffer: 32768,
});
assert.ifError(child.error);
process.stderr.write(child.stderr);
assert.equal(child.status, 1, child.stdout);
assert.equal(JSON.parse(child.stdout).code, 'DEPLOYMENT_BACKUP_MISSING');
'@
    & $node -e $restoreWithoutGit $pwsh $restore $project $root
    Assert ($LASTEXITCODE -eq 0) 'Public restore admission incorrectly requires Git or inherits Node hooks'
    Assert (@(Get-ChildItem -LiteralPath $project -Force).Count -eq 0) 'Refused restore mutated project files'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root '.project.deployment/lock'))) 'Missing backup restore acquired a lock'
    Write-Output 'PASS: public Windows help, unsupported modes and status have no deployment side effects'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
