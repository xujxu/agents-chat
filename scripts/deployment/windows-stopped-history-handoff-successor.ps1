. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-settlement-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffSuccessorBinding(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorPreparer') -or
        $Context.HistoryHandoffSuccessorPreparer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffLockSettlementObserver') -or
        $Context.HistoryHandoffLockSettlementObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockSettler')) {
        throw 'Successor preparation requires its independent native role.'
    }
    $previous = $Context.HistoryHandoffObservedCommit
    $old = $Context.HistoryHandoffLock.OwnerRequest
    $oldIds = @($Context.OperationId, $previous.AttemptId, $old.OperationId, $old.Token)
    foreach ($value in @($AttemptId, $OperationId, $Token)) {
        Assert-AgentsChatCompletionGuid $value
        if ($value -cin $oldIds) {
            throw 'Successor preparation requires fresh distinct owner identifiers.'
        }
    }
    if (@($AttemptId, $OperationId, $Token | Select-Object -Unique).Count -ne 3) {
        throw 'Successor preparation requires fresh distinct owner identifiers.'
    }
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $Context.HistoryHandoffLockSettlement.SettledAt
    Assert-AgentsChatStoppedHistoryHandoffLockSettlement $Context
    $record = Read-AgentsChatRetirementJson ($previous.Prepared.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-prepared' -or
        $record.attemptId -cne $previous.AttemptId) {
        throw 'Successor original prepared template differs.'
    }
    $state = [Text.Json.JsonDocument]::Parse($record.oldState)
    try { $updatedAt = $state.RootElement.GetProperty('updatedAt').GetString() }
    finally { $state.Dispose() }
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=$updatedAt
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
    $record.phase = 'stopped-history-handoff-successor-prepared'
    $record.attemptId = $AttemptId
    $record.newOwner = $owner
    $intent = $Context.HistoryHandoffLockRetirementIntent
    $terminal = $Context.HistoryHandoffLockSettlement
    $record.predecessor = [ordered]@{
        attemptId=$previous.AttemptId
        prepared=(Get-AgentsChatStoppedHandoffDescriptor $previous.Prepared $previous.PreparedName 1048576)
        committed=(Get-AgentsChatStoppedHandoffDescriptor $previous.Committed $previous.CommittedName)
        retirement=(Get-AgentsChatStoppedHandoffDescriptor $intent.File $intent.Descriptor.path)
        terminal=(Get-AgentsChatStoppedHandoffDescriptor $terminal.File $terminal.Descriptor.path)
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 12 -Compress)) -gt 1048576) {
        throw 'Native successor preparation response is oversized.'
    }
    $null = New-AgentsChatStoppedHistoryHandoffOwner @request
    return $record
}

function Get-AgentsChatStoppedHistoryHandoffSuccessorRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    $null = Get-AgentsChatStoppedHistoryHandoffSuccessorBinding @PSBoundParameters
    $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    $record = Get-AgentsChatStoppedHistoryHandoffSuccessorBinding @PSBoundParameters
    $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    return $record
}
