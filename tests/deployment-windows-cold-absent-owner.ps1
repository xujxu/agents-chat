param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][Diagnostics.Process]$Owner,
    [switch]$ColdActivationCrash
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sessionId = $Owner.SessionId
$observerSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$emptyGeneration = [guid]::NewGuid()
$empty = [Deployment.WindowsWorkerJob]::Create($emptyGeneration)
try {
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty($emptyGeneration, $observerSession)
    if (-not $empty.KillOnClose -or @($empty.Members()).Count -ne 0) {
        throw 'Read-only empty-Job inspection changed the original Job.'
    }
} finally { $empty.Dispose() }
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty($emptyGeneration, $observerSession)
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Ready.generation, $sessionId)
$refused = $false
try { [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Ready.generation, ($observerSession + 1)) }
catch {
    if ($_.Exception.GetBaseException().Message -cne 'Cannot establish original Job absence across sessions.') { throw }
    $refused = $true
}
if (-not $refused) { throw 'Cross-session Job absence was accepted.' }
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-runtime-retirement.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
if ($LASTEXITCODE -ne 0) { throw 'Cold recovery did not retire its authenticated stopped runtime.' }
if (-not $Owner.WaitForExit(15000) -or $Owner.ExitCode -ne 0) {
    throw 'Original stopped host did not retire cleanly.'
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$deadline = [Diagnostics.Stopwatch]::StartNew()
while ($folder.GetTask($TaskName).GetInstances(0).Count -ne 0) {
    if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Original Scheduler instance did not settle.' }
    Start-Sleep -Milliseconds 100
}
if ($folder.GetTask($TaskName).Enabled) { throw 'Absent original runtime is not inhibited.' }
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Ready.generation, $sessionId)
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-absent-owner.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
if ($LASTEXITCODE -ne 0) { throw 'Cold restore refused the genuinely absent original runtime.' }
if ($folder.GetTask($TaskName).Enabled -or $folder.GetTask($TaskName).GetInstances(0).Count -ne 0) {
    throw 'Cold absence admission started or enabled the original task.'
}
Write-Output 'PASS: cold recovery admits an absent original host with no Scheduler instance and unchanged task inhibition'
if ($ColdActivationCrash) {
    $output = & (Join-Path $PSScriptRoot 'deployment-windows-cold-activation-crash.ps1') -Control $Control
} else {
    $output = & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-activation.mjs') `
        $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if ($LASTEXITCODE -ne 0) { throw 'Cold recovery did not start and settle its own guarded replacement.' }
}
$activated = ($output -join "`n") | ConvertFrom-Json
if ($activated.status -cne 'guarded-running' -or $activated.taskName -cne $TaskName -or
    $activated.runtime.generation -ceq $Ready.generation) {
    throw 'Cold activation reported a foreign or reused runtime.'
}
$task = $folder.GetTask($TaskName)
if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
    [string]$task.Xml -cne $activated.definition -or
    [string]$task.GetSecurityDescriptor(7) -cne $activated.securityDescriptor -or
    $task.Definition.Triggers.Count -ne 0) {
    throw 'Closed cold activation did not preserve its inhibited guarded policy.'
}
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$activated.runtime.generation, $activated.runtime.sessionId)
Write-Output 'PASS: cold activation starts a distinct leased runtime and settles its original new Job without terminal state or automatic task triggers'
$phase = if ($ColdActivationCrash) { 'running' } else { 'stopped' }
& (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-activation-recovery.mjs') `
    $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) $phase
if ($LASTEXITCODE -ne 0) { throw 'Independent cold activation inspection did not retain its original inactive history.' }
$task = $folder.GetTask($TaskName)
if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
    [string]$task.Xml -cne $activated.definition -or
    [string]$task.GetSecurityDescriptor(7) -cne $activated.securityDescriptor) {
    throw 'Read-only cold activation inspection changed task policy or started a runtime.'
}
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$activated.runtime.generation, $activated.runtime.sessionId)
& (Join-Path $PSScriptRoot 'deployment-windows-cold-policy-recovery.ps1') -Control $Control -TaskName $TaskName
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$activated.runtime.generation, $activated.runtime.sessionId)
