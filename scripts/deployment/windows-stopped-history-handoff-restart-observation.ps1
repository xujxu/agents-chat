. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-publication.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffRestartObservation([hashtable]$Context, $Descriptor, $Committed) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver') -or
        $Context.HistoryHandoffSuccessorAbandonedObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartPreparer') -or
        $Context.ContainsKey('HistoryHandoffRestartPublisher') -or
        $Context.ContainsKey('HistoryHandoffRestartObserver') -or
        $Context.ContainsKey('HistoryHandoffRestartPrepared')) {
        throw 'Restart observation bootstrap differs.'
    }
    $attempt = Get-AgentsChatStoppedHistoryHandoffSuccessorAttempt $Descriptor `
        $Context.HistoryHandoffSuccessorPrepared.Request.AttemptId
    $name = "inactive-handoff-$attempt-prepared.json"
    $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($held.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation', 'predecessor'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-restart-prepared' -or
        $record.attemptId -cne $attempt) {
        throw 'Restart observation scope differs.'
    }
    Assert-AgentsChatRetirementFields $record.newOwner @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt'
    )
    if ($record.newOwner.pid -isnot [int]) { throw 'Restart observation owner PID differs.' }
    $Context.HistoryHandoffRestartPrepared = @{
        File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name 1048576)
        Request=@{
            ControllerPid=$record.newOwner.pid; ControllerIdentity=$record.newOwner.processIdentity
            AttemptId=$attempt; OperationId=$record.newOwner.operationId
            Token=$record.newOwner.token; CreatedAt=$record.newOwner.createdAt
        }
    }
    $Context.HistoryHandoffRestartObserver = $true
    if ($null -ne $Committed) {
        Initialize-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Context $Committed
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
}

function Get-AgentsChatStoppedHistoryHandoffRestartPreparedObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffRestartObserver') -or
            $Context.HistoryHandoffRestartObserver -ne $true -or
            $Context.ContainsKey('HistoryHandoffRestartPreparer') -or
            $Context.ContainsKey('HistoryHandoffRestartPublisher')) {
            throw 'Restart observation requires its independent native role.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
        $observed = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
        $retained = $Context.HistoryHandoffRestartPrepared
        $request = $retained.Request
        $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
        return [ordered]@{
            status='restart-prepared-observed'; attemptId=$record.attemptId
            previousAttemptId=$observed.attemptId; previousOperationId=$observed.previousOperationId
            project=$observed.project; prepared=$retained.Descriptor; predecessor=$record.predecessor
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart prepared observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffRestartObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $Abandoned, $Restart,
    $RestartCommitted, $RestartStateIntent, $RestartState, $RestartRetirement, $RestartSettlement
) {
    $scope = $null
    try {
        if ($null -eq $Restart) { throw 'Restart prepared descriptor is required.' }
        $scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control $ControllerPid $ControllerIdentity `
            $AttemptId $Prepared $Committed $Retirement $Terminal $Successor $Abandoned $Restart $RestartCommitted `
            $RestartStateIntent $RestartState $RestartRetirement $RestartSettlement
        Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $scope
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Restart observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Restart prepared observation failed; retain evidence.', $failure)
    }
}
