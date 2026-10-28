function Test-AgentsChatStoppedHistoryHandoffRestartLockDirectory(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, [switch]$Continue
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-lock.ps1')
    $refused = $false
    try { $null = New-AgentsChatStoppedHistoryHandoffRestartLockDirectory $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart lock publication requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Prepared restart acquired a lock directory without its independent role.' }
    $Context.HistoryHandoffRestartLockPublisher = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    $identity = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity directory
    Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
    $retained = $Context.HistoryHandoffRestartLock
    $before = $retained.Directory.CaptureIdentity()
    if ($before.Dev -cne $identity.dev -or $before.Ino -cne $identity.ino) {
        throw 'Restart lock directory does not bind its retained native identity.'
    }
    $result = [ordered]@{
        status='restart-lock-directory'; attemptId=$Context.HistoryHandoffRestartPrepared.Request.AttemptId
        prepared=$Context.HistoryHandoffRestartPrepared.Descriptor; directory=$identity
        runtimeAuthority=$false; lockAuthority=$false
    }
    if ($Continue) { return $result }
    $refused = $false
    try { $null = New-AgentsChatStoppedHistoryHandoffRestartLockDirectory $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart lock publication failed; retain evidence.') { throw }
        $refused = $true
    }
    $retained.Directory.Check()
    $after = $retained.Directory.CaptureIdentity()
    if (-not $refused -or -not $Context.Poisoned -or
        $after.Dev -cne $before.Dev -or $after.Ino -cne $before.Ino -or
        @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force).Count) {
        throw 'Duplicate restart directory publication failed to preserve and poison.'
    }
    return $result
}
