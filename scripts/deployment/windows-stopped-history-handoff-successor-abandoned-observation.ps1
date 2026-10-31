. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor-abandonment.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorObserver') -or
        $Context.HistoryHandoffSuccessorObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffSuccessorAbandoner') -or
        $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver') -or
        $Context.ContainsKey('HistoryHandoffSuccessorAbandoned')) {
        throw 'Successor abandoned observation bootstrap differs.'
    }
    $prepared = $Context.HistoryHandoffSuccessorPrepared
    $name = "inactive-handoff-$($prepared.Request.AttemptId)-abandoned.json"
    Assert-AgentsChatRetirementDescriptor $Descriptor $name 65536
    $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($held.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'prepared', 'creator', 'settledAt'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-successor-abandoned' -or
        $record.attemptId -cne $prepared.Request.AttemptId) {
        throw 'Successor abandoned observation scope differs.'
    }
    $observer = $Context.HistoryHandoffObservedCommit
    Assert-AgentsChatRetirementCreator $record.creator $observer.ControllerPid $observer.ControllerIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.pid $record.creator.processIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.bridgePid $record.creator.bridgeIdentity
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $record.settledAt $prepared.Request.CreatedAt
    $Context.HistoryHandoffSuccessorAbandoned = @{
        File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
        Creator=$record.creator; SettledAt=$record.settledAt
    }
    $Context.HistoryHandoffSuccessorAbandonedObserver = $true
    Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context
}

function Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver') -or
            $Context.HistoryHandoffSuccessorAbandonedObserver -ne $true -or
            $Context.ContainsKey('HistoryHandoffSuccessorAbandoner')) {
            throw 'Successor abandoned observation requires its independent native role.'
        }
        Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context
        $observed = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context
        $terminal = $Context.HistoryHandoffSuccessorAbandoned
        return [ordered]@{
            status='successor-abandoned-observed'; attemptId=$observed.attemptId
            previousAttemptId=$observed.previousAttemptId; previousOperationId=$observed.previousOperationId
            project=$observed.project; prepared=$observed.prepared; abandoned=$terminal.Descriptor
            predecessor=$observed.predecessor; creator=$terminal.Creator; settledAt=$terminal.SettledAt
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Successor abandoned observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $Abandoned
) {
    $scope = $null
    try {
        if ($null -eq $Abandoned) { throw 'Successor abandoned descriptor is required.' }
        $scope = Open-AgentsChatStoppedHistoryHandoffSuccessorObservation $Control `
            $ControllerPid $ControllerIdentity $AttemptId $Prepared $Committed $Retirement $Terminal $Successor `
            -SuccessorAbandoned $Abandoned
        Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $scope
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Successor abandoned observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Successor abandoned observation failed; retain evidence.', $failure)
    }
}
