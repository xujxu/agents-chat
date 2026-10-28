function Test-AgentsChatStoppedHistoryHandoffRestartOwner(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-owner.ps1')
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart owner publication requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Restart directory published an owner without its independent role.' }
    $Context.HistoryHandoffRestartOwnerPublisher = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    $descriptor = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity owner
    Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
    $Context.HistoryHandoffRestartOwnerPublisher = $false
    $refused = $false
    try { Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context }
    catch {
        if ($_.Exception.Message -cne 'Restart lock owner lacks retained independent native publication proof.') { throw }
        $refused = $true
    } finally { $Context.HistoryHandoffRestartOwnerPublisher = $true }
    if (-not $refused) { throw 'Restart owner observation accepted a scope without its independent role.' }
    Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
    $retained = $Context.HistoryHandoffRestartLock
    $before = $retained.Directory.CaptureIdentity()
    $bytes = $retained.OwnerFile.ReadText()
    $result = [ordered]@{
        status='restart-lock-owner'; attemptId=$Context.HistoryHandoffRestartPrepared.Request.AttemptId
        prepared=$Context.HistoryHandoffRestartPrepared.Descriptor
        directory=$retained.DirectoryIdentity; owner=$descriptor
        runtimeAuthority=$false; lockAuthority=$false
    }
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart owner publication failed; retain evidence.') { throw }
        $refused = $true
    }
    $retained.Directory.Check()
    $after = $retained.Directory.CaptureIdentity()
    $actual = Get-AgentsChatStoppedHandoffDescriptor $retained.OwnerFile 'lock\owner.json'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($actual[$field] -cne $descriptor[$field]) { throw 'Duplicate restart owner publication changed its descriptor.' }
    }
    if (-not $refused -or -not $Context.Poisoned -or
        $after.Dev -cne $before.Dev -or $after.Ino -cne $before.Ino -or
        $retained.OwnerFile.ReadText() -cne $bytes -or
        @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force).Count -ne 1) {
        throw 'Duplicate restart owner publication failed to preserve and poison.'
    }
    return $result
}
