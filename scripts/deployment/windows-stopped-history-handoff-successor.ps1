. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-settlement-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffSuccessorRecord(
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
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
    $observed = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    $record = Get-AgentsChatStoppedHistoryHandoffBinding $Context $AttemptId $owner
    $record.phase = 'stopped-history-handoff-successor-prepared'
    $record.predecessor = [ordered]@{
        attemptId=$observed.attemptId
        prepared=$observed.prepared; committed=$observed.committed
        retirement=$observed.retirement; terminal=$observed.terminal
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 12 -Compress)) -gt 1048576) {
        throw 'Native successor preparation response is oversized.'
    }
    $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
    $null = New-AgentsChatStoppedHistoryHandoffOwner @request
    return $record
}
