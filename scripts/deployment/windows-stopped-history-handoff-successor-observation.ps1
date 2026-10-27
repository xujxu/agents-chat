. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor-publication.ps1')

function Get-AgentsChatStoppedHistoryHandoffSuccessorAttempt($Descriptor, [string]$PreviousAttempt) {
    Assert-AgentsChatRetirementFields $Descriptor @('path', 'dev', 'ino', 'bytes', 'sha256')
    if ($Descriptor.path -isnot [string] -or
        $Descriptor.path -cnotmatch '^inactive-handoff-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-prepared\.json$') {
        throw 'Successor observation filename differs.'
    }
    $attempt = $Matches[1]
    Assert-AgentsChatCompletionGuid $attempt
    if ($attempt -ceq $PreviousAttempt) { throw 'Successor observation reuses its predecessor attempt.' }
    Assert-AgentsChatRetirementDescriptor $Descriptor "inactive-handoff-$attempt-prepared.json" 1048576
    return $attempt
}

function Initialize-AgentsChatStoppedHistoryHandoffSuccessorObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffLockSettlementObserver') -or
        $Context.HistoryHandoffLockSettlementObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockSettler') -or
        $Context.ContainsKey('HistoryHandoffSuccessorPreparer') -or
        $Context.ContainsKey('HistoryHandoffSuccessorPublisher') -or
        $Context.ContainsKey('HistoryHandoffSuccessorObserver') -or
        $Context.ContainsKey('HistoryHandoffSuccessorPrepared')) {
        throw 'Successor observation bootstrap differs.'
    }
    $previous = $Context.HistoryHandoffObservedCommit
    $attempt = Get-AgentsChatStoppedHistoryHandoffSuccessorAttempt $Descriptor $previous.AttemptId
    $name = "inactive-handoff-$attempt-prepared.json"
    $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($held.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation', 'predecessor'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-successor-prepared' -or
        $record.attemptId -cne $attempt) {
        throw 'Successor observation scope differs.'
    }
    Assert-AgentsChatRetirementFields $record.newOwner @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt'
    )
    if ($record.newOwner.pid -isnot [int]) { throw 'Successor observation owner PID differs.' }
    $Context.HistoryHandoffSuccessorPrepared = @{
        File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name 1048576)
        Request=@{
            ControllerPid=$record.newOwner.pid; ControllerIdentity=$record.newOwner.processIdentity
            AttemptId=$attempt; OperationId=$record.newOwner.operationId
            Token=$record.newOwner.token; CreatedAt=$record.newOwner.createdAt
        }
    }
    $Context.HistoryHandoffSuccessorObserver = $true
    Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
}

function Open-AgentsChatStoppedHistoryHandoffSuccessorObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor
) {
    $scope = $null
    try {
        if ($null -eq $Successor) { throw 'Successor descriptor is required.' }
        $scope = Open-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Control `
            $ControllerPid $ControllerIdentity $AttemptId $Prepared $Committed $Retirement $Terminal `
            -Successor $Successor
        Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $scope
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Successor observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Successor prepared observation failed; retain evidence.', $failure)
    }
}
