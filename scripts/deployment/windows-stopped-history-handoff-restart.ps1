. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor-abandoned-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartBinding(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    $preparer = $Context.ContainsKey('HistoryHandoffRestartPreparer') -and
        $Context.HistoryHandoffRestartPreparer -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        $Context.HistoryHandoffRestartObserver -eq $true
    if ($preparer -eq $observer -or
        ($preparer -and $Context.ContainsKey('HistoryHandoffRestartObserver')) -or
        ($observer -and ($Context.ContainsKey('HistoryHandoffRestartPreparer') -or
            $Context.ContainsKey('HistoryHandoffRestartPublisher'))) -or
        -not $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver') -or
        $Context.HistoryHandoffSuccessorAbandonedObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffSuccessorObserver') -or
        $Context.HistoryHandoffSuccessorObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffSuccessorPreparer') -or
        $Context.ContainsKey('HistoryHandoffSuccessorPublisher') -or
        $Context.ContainsKey('HistoryHandoffSuccessorAbandoner')) {
        throw 'Restart preparation requires its independent native role.'
    }
    $previous = $Context.HistoryHandoffObservedCommit
    if ($preparer -and ($ControllerPid -ne $previous.ControllerPid -or
        $ControllerIdentity -cne $previous.ControllerIdentity)) {
        throw 'Restart preparation controller differs.'
    }
    $old = $Context.HistoryHandoffLock.OwnerRequest
    $successor = $Context.HistoryHandoffSuccessorPrepared
    $terminal = $Context.HistoryHandoffSuccessorAbandoned
    $oldIds = @($Context.OperationId, $previous.AttemptId, $old.OperationId, $old.Token,
        $successor.Request.AttemptId, $successor.Request.OperationId, $successor.Request.Token)
    foreach ($value in @($AttemptId, $OperationId, $Token)) {
        Assert-AgentsChatCompletionGuid $value
        if ($value -cin $oldIds) {
            throw 'Restart preparation requires fresh distinct owner identifiers.'
        }
    }
    if (@($AttemptId, $OperationId, $Token | Select-Object -Unique).Count -ne 3) {
        throw 'Restart preparation requires fresh distinct owner identifiers.'
    }
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $terminal.SettledAt
    $record = Read-AgentsChatRetirementJson ($previous.Prepared.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-prepared' -or
        $record.attemptId -cne $previous.AttemptId) {
        throw 'Restart original prepared template differs.'
    }
    $state = [Text.Json.JsonDocument]::Parse($record.oldState)
    try { $updatedAt = $state.RootElement.GetProperty('updatedAt').GetString() }
    finally { $state.Dispose() }
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=$updatedAt; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $record.phase = 'stopped-history-handoff-restart-prepared'
    $record.attemptId = $AttemptId
    $record.newOwner = if ($observer) { Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
        else { New-AgentsChatStoppedHistoryHandoffOwner @request }
    $intent = $Context.HistoryHandoffLockRetirementIntent
    $settlement = $Context.HistoryHandoffLockSettlement
    $record.predecessor = [ordered]@{
        attemptId=$successor.Request.AttemptId
        prepared=(Get-AgentsChatStoppedHandoffDescriptor $successor.File $successor.Descriptor.path 1048576)
        abandoned=(Get-AgentsChatStoppedHandoffDescriptor $terminal.File $terminal.Descriptor.path)
        predecessor=[ordered]@{
            attemptId=$previous.AttemptId
            prepared=(Get-AgentsChatStoppedHandoffDescriptor $previous.Prepared $previous.PreparedName 1048576)
            committed=(Get-AgentsChatStoppedHandoffDescriptor $previous.Committed $previous.CommittedName)
            retirement=(Get-AgentsChatStoppedHandoffDescriptor $intent.File $intent.Descriptor.path)
            terminal=(Get-AgentsChatStoppedHandoffDescriptor $settlement.File $settlement.Descriptor.path)
        }
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 16 -Compress)) -gt 1048576) {
        throw 'Native restart preparation response is oversized.'
    }
    if ($observer) { $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request }
    else { $null = New-AgentsChatStoppedHistoryHandoffOwner @request }
    return $record
}

function Get-AgentsChatStoppedHistoryHandoffRestartRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartPreparer') -or
        $Context.HistoryHandoffRestartPreparer -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart preparation requires its independent native role.'
    }
    $null = Get-AgentsChatStoppedHistoryHandoffRestartBinding @PSBoundParameters
    $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding @PSBoundParameters
    $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
    return $record
}
