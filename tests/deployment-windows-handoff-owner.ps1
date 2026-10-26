$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path (Join-Path $source 'WindowsWorkerJob.cs')
. (Join-Path $source 'windows-stopped-history-handoff-owner.ps1')
function Assert-OwnerRefused([hashtable]$Request) {
    try { $null = New-AgentsChatStoppedHistoryHandoffOwner @Request }
    catch {
        if ($_.Exception.Message -notmatch 'Handoff prospective owner') { throw }
        return
    }
    throw 'Expected native prospective owner refusal.'
}
$request = @{
    Project=[IO.Path]::GetDirectoryName($PSScriptRoot)
    PreviousOperationId='11111111-1111-4111-8111-111111111111'
    AttemptId='22222222-2222-4222-8222-222222222222'
    OperationId='33333333-3333-4333-8333-333333333333'
    Token='44444444-4444-4444-8444-444444444444'
    CreatedAt='2026-10-26T00:00:01.000Z'
    PreviousUpdatedAt='2026-10-26T00:00:00.000Z'
    ControllerPid=$PID
    ControllerIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
}
$owner = New-AgentsChatStoppedHistoryHandoffOwner @request
if ($owner.pid -ne $PID -or $owner.processIdentity -cne $request.ControllerIdentity -or
    $owner.operationId -cne $request.OperationId -or $owner.token -cne $request.Token -or
    $owner.project -cne $request.Project -or $owner.createdAt -cne $request.CreatedAt -or
    $owner.version -ne 1 -or $owner.Count -ne 7) { throw 'Native owner binding differs.' }
$foreign = $request.Clone()
$foreign.ControllerIdentity = "$PID`:1"
Assert-OwnerRefused $foreign
function Assert-RetiredOwnerRefused([hashtable]$Request) {
    try { $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @Request }
    catch {
        if ($_.Exception.Message -notmatch 'Handoff retired owner') { throw }
        return
    }
    throw 'Expected live original actor to prevent retired owner observation.'
}
Assert-RetiredOwnerRefused $request
$child = $null
try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $start.UseShellExecute = $false
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60')) {
        $start.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($start)
    $exited = $request.Clone()
    $exited.ControllerPid = $child.Id
    $exited.ControllerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($child.Id)
    $liveChild = New-AgentsChatStoppedHistoryHandoffOwner @exited
    $child.Kill()
    if (-not $child.WaitForExit(15000)) { throw 'Original test process did not exit.' }
    Assert-OwnerRefused $exited
    $retired = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @exited
    foreach ($key in $liveChild.Keys) {
        if ($retired[$key] -cne $liveChild[$key]) { throw 'Retired owner fields changed after actual actor exit.' }
    }
    Write-Host 'PASS: native retired handoff owner requires actual original actor absence without granting authority'
} finally {
    if ($child) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
}
Write-Host 'PASS: native prospective handoff owner binds live identity and refuses foreign or exited actors'
