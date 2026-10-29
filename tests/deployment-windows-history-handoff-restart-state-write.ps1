function Test-AgentsChatStoppedHistoryHandoffRestartStateWrite(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-state-write.ps1')
    $refused = $false
    try { $null = Write-AgentsChatStoppedHistoryHandoffRestartState $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart state write requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Restart state written without its independent role.' }
    if (Test-Path -LiteralPath (Join-Path $Context.Control 'state.json.lock')) {
        throw 'Refused restart state write left a stage.'
    }
    $intent = $Context.HistoryHandoffRestartStateIntent
    $intentText = $intent.File.ReadText()
    $committedText = $Context.HistoryHandoffRestartCommitted.File.ReadText()
    $ownerText = $Context.HistoryHandoffRestartLock.OwnerFile.ReadText()
    $Context.HistoryHandoffRestartStateWriter = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    $descriptor = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity state-write
    $written = $Context.HistoryHandoffRestartState
    $document = [Text.Json.JsonDocument]::Parse($intentText)
    try { $expected = $document.RootElement.GetProperty('nextState').GetRawText() + "`n" }
    finally { $document.Dispose() }
    $text = $written.File.ReadText()
    if ($descriptor.path -cne 'state.json' -or $text -cne $expected) { throw 'Restart state write text differs from its intent.' }
    $actual = Get-AgentsChatStoppedHandoffDescriptor $written.File 'state.json'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($actual[$field] -cne $descriptor[$field]) { throw 'Restart state write descriptor differs.' }
    }
    foreach ($pattern in @('state.json.lock', 'state.json.lock.pending-*')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
            throw 'Restart state write retained a stage.'
        }
    }
    if ($intent.File.ReadText() -cne $intentText -or
        $Context.HistoryHandoffRestartCommitted.File.ReadText() -cne $committedText -or
        $Context.HistoryHandoffRestartLock.OwnerFile.ReadText() -cne $ownerText) {
        throw 'Restart state write changed its retained records.'
    }
    $result = [ordered]@{
        status='restart-state-written'; attemptId=$Context.HistoryHandoffRestartPrepared.Request.AttemptId
        stateIntent=$intent.Descriptor; state=$descriptor
        runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
    }
    $refused = $false
    try { $null = Write-AgentsChatStoppedHistoryHandoffRestartState $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart state write failed; retain evidence.') { throw }
        $refused = $true
    }
    $after = Get-AgentsChatStoppedHandoffDescriptor $written.File 'state.json'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($after[$field] -cne $descriptor[$field]) { throw 'Duplicate restart state write changed state.' }
    }
    if (-not $refused -or -not $Context.Poisoned -or $intent.File.ReadText() -cne $intentText -or
        (Test-Path -LiteralPath (Join-Path $Context.Control 'state.json.lock'))) {
        throw 'Duplicate restart state write failed to preserve and poison.'
    }
    return $result
}
