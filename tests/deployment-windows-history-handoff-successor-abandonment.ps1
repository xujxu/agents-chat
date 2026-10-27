function Test-AgentsChatStoppedHistoryHandoffSuccessorAbandonment(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-successor-abandonment.ps1')
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Successor abandonment requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Successor abandonment accepted a scope without its independent role.' }
    $Context.HistoryHandoffSuccessorAbandoner = $true
    $descriptor = Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context $ControllerPid $ControllerIdentity
    $file = Join-Path $Context.Control $descriptor.path
    $bytes = [IO.File]::ReadAllBytes($file)
    $record = Read-AgentsChatRetirementJson ([IO.File]::ReadAllText($file))
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Successor abandonment failed; retain evidence.') { throw }
        $refused = $true
    }
    if (-not $refused -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -cne [Convert]::ToBase64String($bytes)) {
        throw 'Duplicate successor abandonment replaced immutable evidence.'
    }
    return [ordered]@{ abandoned=$descriptor; record=$record }
}
