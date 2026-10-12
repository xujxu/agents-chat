param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][Diagnostics.Process]$Owner
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sessionId = $Owner.SessionId
$emptyGeneration = [guid]::NewGuid()
$empty = [Deployment.WindowsWorkerJob]::Create($emptyGeneration)
try {
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty($emptyGeneration, $sessionId)
    if (-not $empty.KillOnClose -or @($empty.Members()).Count -ne 0) {
        throw 'Read-only empty-Job inspection changed the original Job.'
    }
} finally { $empty.Dispose() }
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty($emptyGeneration, $sessionId)
[Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Ready.generation, $sessionId)
$refused = $false
try { [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Ready.generation, ($sessionId + 1)) }
catch {
    if ($_.Exception.GetBaseException().Message -cne 'Cannot establish original Job absence across sessions.') { throw }
    $refused = $true
}
if (-not $refused) { throw 'Cross-session Job absence was accepted.' }
$reply = [Deployment.WindowsRuntimeControl]::Exchange(
    [guid]$Ready.generation, $Ready.pid, $Ready.identity, 'retire', 15000)
if ($reply -cne 'retired' -or -not $Owner.WaitForExit(15000) -or $Owner.ExitCode -ne 0) {
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
