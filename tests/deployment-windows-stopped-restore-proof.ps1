param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$OperationId,
    [switch]$LiveOwner
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-stopped-restore-proof.ps1')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Refused([string]$Cause) {
    $proof = $null
    $refused = $false
    try { $proof = Open-AgentsChatStoppedRestoreProof -Control $Control }
    catch {
        if ($_.Exception.ToString() -cnotmatch [regex]::Escape($Cause)) { throw }
        $refused = $true
    } finally { if ($proof) { Close-AgentsChatTaskCompletionProof $proof } }
    Assert $refused "Stopped restore proof unexpectedly accepted: $Cause"
}
if ($LiveOwner) {
    Refused 'original-processes'
    return
}
$directory = Join-Path $Control 'task-maintenance'
$files = @((Join-Path $Control 'lock/owner.json'), (Join-Path $Control 'state.json'),
    (Join-Path $Control 'worker-operation.ndjson')) +
    @(Get-ChildItem -LiteralPath $directory -File | ForEach-Object FullName) +
    @(Get-ChildItem -LiteralPath (Join-Path $Control 'worker-engine') -File | ForEach-Object FullName)
$workerManifest = Get-Content -LiteralPath (Join-Path $Control 'worker-engine/manifest.json') -Raw | ConvertFrom-Json
$workerHelper = Join-Path (Join-Path $Control 'worker-engine') $workerManifest.files[0].name
$before = @($files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
$proof = Open-AgentsChatStoppedRestoreProof -Control $Control
try {
    $result = Assert-AgentsChatStoppedRestoreProof $proof
    Assert ($result.status -ceq 'observed' -and -not $result.mutationAuthority) 'Unexpected mutation authority'
    Assert ($result.operationId -ceq $OperationId -and $result.taskName -ceq $TaskName) 'Original binding differs'
    Assert ($result.stopped -and $result.inhibited) 'Original runtime is not settled'
    Assert ($result.stateSha256 -ceq $before[1].ToLowerInvariant()) 'Retained state differs'
    $denied = $false
    try { [IO.File]::WriteAllText((Join-Path $Control 'lock/owner.json'), 'changed') }
    catch [IO.IOException] { $denied = $true }
    Assert $denied 'Retained original lock allowed replacement'
    $denied = $false
    try { [IO.File]::WriteAllText((Join-Path $Control 'worker-operation.ndjson'), 'changed') }
    catch [IO.IOException] { $denied = $true }
    Assert $denied 'Retained original worker evidence allowed replacement'
    $denied = $false
    try { [IO.File]::WriteAllText($workerHelper, 'changed') }
    catch [IO.IOException] { $denied = $true }
    Assert $denied 'Retained original worker helper allowed replacement'
    $null = Assert-AgentsChatStoppedRestoreProof $proof
} finally { Close-AgentsChatTaskCompletionProof $proof }

$foreignWorker = Join-Path $Control 'worker-foreign.ndjson'
$file = [Deployment.WindowsPrivateFile]::Publish($foreignWorker, '{}')
$file.Dispose()
try { Refused 'worker-inventory' }
finally { [IO.File]::Delete($foreignWorker) }
$workerFile = Join-Path $Control 'worker-operation.ndjson'
$workerBytes = [IO.File]::ReadAllText($workerFile)
try {
    $invalid = $workerBytes.Replace('"phase":"opened"', '"phase":"sealed"')
    Assert ($invalid -cne $workerBytes) 'Fixture did not change the original opened worker operation'
    [IO.File]::WriteAllText($workerFile, $invalid, [Text.UTF8Encoding]::new($false))
    Refused 'worker-evidence'
} finally { [IO.File]::WriteAllText($workerFile, $workerBytes, [Text.UTF8Encoding]::new($false)) }
$helperBytes = [IO.File]::ReadAllBytes($workerHelper)
try {
    [IO.File]::WriteAllText($workerHelper, 'changed', [Text.UTF8Encoding]::new($false))
    Refused 'worker-helper'
} finally { [IO.File]::WriteAllBytes($workerHelper, $helperBytes) }
$foreignHelper = Join-Path $Control 'worker-engine/foreign.mjs'
$file = [Deployment.WindowsPrivateFile]::Publish($foreignHelper, '{}')
$file.Dispose()
try { Refused 'worker-inventory' }
finally { [IO.File]::Delete($foreignHelper) }

$foreign = Join-Path $directory 'foreign.json'
$file = [Deployment.WindowsPrivateFile]::Publish($foreign, '{}')
$file.Dispose()
try { Refused 'inventory' }
finally { [IO.File]::Delete($foreign) }

$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\').GetTask($TaskName)
$task.Enabled = $true
try { Refused 'task-policy' }
finally { $scheduler.GetFolder('\').GetTask($TaskName).Enabled = $false }

$stateFile = Join-Path $Control 'state.json'
$original = [IO.File]::ReadAllText($stateFile)
$failed = $original.Replace('"phase":"restoring"', '"phase":"recovery-required"').
    Replace('"previousPhase":"restore-preflight"', '"previousPhase":"restoring"').
    Replace('"errorCode":null', '"errorCode":"DEPLOYMENT_RESTORE_FAILED"')
Assert ($failed -cne $original) 'Fixture did not change the restoring state'
try {
    [IO.File]::WriteAllText($stateFile, $failed, [Text.UTF8Encoding]::new($false))
    $proof = Open-AgentsChatStoppedRestoreProof -Control $Control
    try { $null = Assert-AgentsChatStoppedRestoreProof $proof }
    finally { Close-AgentsChatTaskCompletionProof $proof }
    [IO.File]::WriteAllText($stateFile, $failed.Replace('"previousPhase":"restoring"', '"previousPhase":"restore-activating"'),
        [Text.UTF8Encoding]::new($false))
    Refused 'state'
} finally { [IO.File]::WriteAllText($stateFile, $original, [Text.UTF8Encoding]::new($false)) }

$after = @($files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
Assert (($before -join ',') -ceq ($after -join ',')) 'Stopped proof changed original recovery evidence'
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-stopped-restore-controller.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) $TaskName $OperationId
Assert ($LASTEXITCODE -eq 0) 'Stopped restore native bridge contracts failed'
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-restore-files.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
Assert ($LASTEXITCODE -eq 0) 'Cold restore original-backup file retry failed'
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-files-receipt.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
Assert ($LASTEXITCODE -eq 0) 'Cold restore durable file-completion receipt failed'
$after = @($files | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
Assert (($before -join ',') -ceq ($after -join ',')) 'Stopped restore bridge changed original evidence'
Write-Output 'PASS: stopped restore proof retains original evidence and refuses live owner, policy, inventory and state drift'
