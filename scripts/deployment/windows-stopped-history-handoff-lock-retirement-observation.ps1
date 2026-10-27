. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-retirement-intent.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffLockRetirementObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffObservedCommit') -or
        -not $Context.ContainsKey('HistoryHandoffLockObserver') -or $Context.HistoryHandoffLockObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockRetirer') -or
        $Context.ContainsKey('HistoryHandoffLockRetirementIntent')) {
        throw 'Lock retirement observation bootstrap differs.'
    }
    $retained = $Context.HistoryHandoffObservedCommit
    $name = "inactive-handoff-$($retained.AttemptId)-lock-retirement.json"
    Assert-AgentsChatRetirementDescriptor $Descriptor $name 65536
    $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($held.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'creator', 'createdAt'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-lock-retirement-prepared' -or
        $record.attemptId -cne $retained.AttemptId -or $record.control -cne $Context.Control -or
        $record.project -cne $Context.Project -or $record.previousOperationId -cne $Context.OperationId) {
        throw 'Lock retirement observation scope differs.'
    }
    Assert-AgentsChatRetirementCreator $record.creator $retained.ControllerPid $retained.ControllerIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.pid $record.creator.processIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.bridgePid $record.creator.bridgeIdentity
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $record.createdAt $retained.CommittedAt
    $Context.HistoryHandoffLockRetirementIntent = @{
        File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
        Creator=$record.creator; CreatedAt=$record.createdAt
    }
    $Context.HistoryHandoffLockRetirementObserver = $true
}

function Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
            $Context.HistoryHandoffLockRetirementObserver -ne $true) {
            throw 'Lock retirement observation requires its independent native role.'
        }
        foreach ($pass in @(1, 2)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
            $creator = $Context.HistoryHandoffLockRetirementIntent.Creator
            Assert-AgentsChatCompletionProcessAbsent $creator.pid $creator.processIdentity
            Assert-AgentsChatCompletionProcessAbsent $creator.bridgePid $creator.bridgeIdentity
        }
        return [ordered]@{
            status=$(if ($Context.HistoryHandoffLock.DirectoryRetired) { 'lock-retirement-directory-retired' }
                elseif ($Context.HistoryHandoffLock.OwnerRetired) { 'lock-retirement-owner-retired' }
                else { 'lock-retirement-observed' })
            attemptId=$observed.attemptId
            previousOperationId=$observed.previousOperationId; project=$observed.project
            prepared=$observed.prepared; committed=$observed.committed
            retirement=$Context.HistoryHandoffLockRetirementIntent.Descriptor
            lockIdentity=$observed.lockIdentity; lock=$observed.lock
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Lock retirement observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffLockRetirementObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $SuccessorAbandoned
) {
    $scope = $null
    try {
        if ($null -eq $Retirement) { throw 'Lock retirement descriptor is required.' }
        $scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control `
            $ControllerPid $ControllerIdentity $AttemptId $Prepared $Committed `
            -Retirement $Retirement -Terminal $Terminal -Successor $Successor -SuccessorAbandoned $SuccessorAbandoned
        if (-not $scope.ContainsKey('HistoryHandoffLockRetirementObserver') -or
            $scope.HistoryHandoffLockRetirementObserver -ne $true) {
            throw 'Lock retirement observation role is missing.'
        }
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Lock retirement observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Lock retirement observation failed; retain evidence.', $failure)
    }
}
