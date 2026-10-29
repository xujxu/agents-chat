function Test-AgentsChatStoppedHistoryHandoffRestartStateIntent(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, [switch]$Continue
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-state-intent.ps1')
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart state intent requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Restart state intent published without its independent role.' }
    $Context.HistoryHandoffRestartStateIntender = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    $descriptor = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity state-intent
    Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
    $retained = $Context.HistoryHandoffRestartStateIntent
    $lock = $Context.HistoryHandoffRestartLock
    $committed = $Context.HistoryHandoffRestartCommitted
    $text = $retained.File.ReadText()
    $ownerText = $lock.OwnerFile.ReadText()
    $committedText = $committed.File.ReadText()
    $before = $lock.Directory.CaptureIdentity()
    $copy = $Context.Clone()
    $copy.HistoryHandoffRestartStateIntent = @{ Descriptor=$descriptor; Record=$text }
    $refused = $false
    try { Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $copy }
    catch {
        if ($_.Exception.Message -cne 'Restart state intent lacks retained independent native proof.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Copied restart state intent JSON and descriptor acquired native proof.' }
    $result = [ordered]@{
        status='restart-state-intent-published'; attemptId=$Context.HistoryHandoffRestartPrepared.Request.AttemptId
        prepared=$Context.HistoryHandoffRestartPrepared.Descriptor; committed=$committed.Descriptor
        stateIntent=$descriptor; directory=$lock.DirectoryIdentity; owner=$lock.OwnerDescriptor
        runtimeAuthority=$false; lockAuthority=$false; stateAuthority=$false
    }
    if ($Continue) { return $result }
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart state intent failed; retain evidence.') { throw }
        $refused = $true
    }
    $actual = Get-AgentsChatStoppedHandoffDescriptor $retained.File $descriptor.path
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($actual[$field] -cne $descriptor[$field]) { throw 'Duplicate restart state intent changed its descriptor.' }
    }
    $after = $lock.Directory.CaptureIdentity()
    if (-not $refused -or -not $Context.Poisoned -or $retained.File.ReadText() -cne $text -or
        $committed.File.ReadText() -cne $committedText -or $lock.OwnerFile.ReadText() -cne $ownerText -or
        $after.Dev -cne $before.Dev -or $after.Ino -cne $before.Ino) {
        throw 'Duplicate restart state intent failed to preserve and poison.'
    }
    return $result
}
