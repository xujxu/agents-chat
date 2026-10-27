function Test-AgentsChatStoppedHistoryHandoffSuccessorPublication(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, $Record
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-successor-publication.ps1')
    $request = @{
        Context=$Context; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=$Record.attemptId; OperationId=$Record.newOwner.operationId
        Token=$Record.newOwner.token; CreatedAt=$Record.newOwner.createdAt
    }
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Successor publication requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Successor publication accepted a scope without its independent role.' }
    $Context.HistoryHandoffSuccessorPublisher = $true
    $descriptor = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request
    $observed = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $Context $ControllerPid $ControllerIdentity
    $file = Join-Path $Context.Control $descriptor.path
    $bytes = [IO.File]::ReadAllBytes($file)
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Successor publication failed; retain evidence.') { throw }
        $refused = $true
    }
    if (-not $refused -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -cne [Convert]::ToBase64String($bytes)) {
        throw 'Duplicate successor publication replaced its immutable evidence.'
    }
    return [ordered]@{ prepared=$descriptor; record=$Record; observation=$observed }
}
