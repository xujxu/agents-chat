function Test-AgentsChatStoppedHistoryHandoffRestartCommit(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, [switch]$Continue
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-commit.ps1')
    $refused = $false
    try { $null = Complete-AgentsChatStoppedHistoryHandoffRestartCommit $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart commitment requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Restart owner committed without its independent role.' }
    $Context.HistoryHandoffRestartCommitter = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    $descriptor = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity committed
    Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
    $retained = $Context.HistoryHandoffRestartCommitted
    $lock = $Context.HistoryHandoffRestartLock
    $text = $retained.File.ReadText()
    $ownerText = $lock.OwnerFile.ReadText()
    $before = $lock.Directory.CaptureIdentity()
    $copy = $Context.Clone()
    $copy.HistoryHandoffRestartCommitted = @{ Descriptor=$descriptor; Record=$text }
    $refused = $false
    try { Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $copy }
    catch {
        if ($_.Exception.Message -cne 'Restart committed record lacks retained independent native proof.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Copied restart committed JSON and descriptor acquired native proof.' }
    $result = [ordered]@{
        status='restart-committed-published'; attemptId=$Context.HistoryHandoffRestartPrepared.Request.AttemptId
        prepared=$Context.HistoryHandoffRestartPrepared.Descriptor; committed=$descriptor
        directory=$lock.DirectoryIdentity; owner=$lock.OwnerDescriptor
        runtimeAuthority=$false; lockAuthority=$false
    }
    if ($Continue) { return $result }
    $refused = $false
    try { $null = Complete-AgentsChatStoppedHistoryHandoffRestartCommit $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart commitment failed; retain evidence.') { throw }
        $refused = $true
    }
    $actual = Get-AgentsChatStoppedHandoffDescriptor $retained.File $descriptor.path
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($actual[$field] -cne $descriptor[$field]) { throw 'Duplicate restart commitment changed its descriptor.' }
    }
    $after = $lock.Directory.CaptureIdentity()
    if (-not $refused -or -not $Context.Poisoned -or $retained.File.ReadText() -cne $text -or
        $lock.OwnerFile.ReadText() -cne $ownerText -or $after.Dev -cne $before.Dev -or $after.Ino -cne $before.Ino) {
        throw 'Duplicate restart commitment failed to preserve and poison.'
    }
    return $result
}
