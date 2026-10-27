. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-settlement.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffLockSettlementObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffObservedCommit') -or
        -not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
        $Context.HistoryHandoffLockRetirementObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockSettler') -or
        $Context.ContainsKey('HistoryHandoffLockSettlement')) {
        throw 'Lock settlement observation bootstrap differs.'
    }
    $retained = $Context.HistoryHandoffObservedCommit
    $name = "inactive-handoff-$($retained.AttemptId)-lock-retired.json"
    Assert-AgentsChatRetirementDescriptor $Descriptor $name 65536
    $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($held.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'retirement', 'newOwner', 'lockIdentity', 'lock', 'creator', 'settledAt'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-lock-retired' -or
        $record.attemptId -cne $retained.AttemptId -or $record.control -cne $Context.Control -or
        $record.project -cne $Context.Project -or $record.previousOperationId -cne $Context.OperationId) {
        throw 'Lock settlement observation scope differs.'
    }
    Assert-AgentsChatRetirementCreator $record.creator $retained.ControllerPid $retained.ControllerIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.pid $record.creator.processIdentity
    Assert-AgentsChatCompletionProcessAbsent $record.creator.bridgePid $record.creator.bridgeIdentity
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $record.settledAt $Context.HistoryHandoffLockRetirementIntent.CreatedAt
    $Context.HistoryHandoffLockSettlement = @{
        File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
        Creator=$record.creator; SettledAt=$record.settledAt
    }
    $Context.HistoryHandoffLockSettlementObserver = $true
}

function Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        Assert-AgentsChatStoppedHistoryHandoffLockSettlement $Context
        foreach ($pass in @(1, 2)) {
            $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
            if ($observed.status -cne 'lock-retirement-directory-retired') {
                throw 'Lock settlement observation requires its exact absent directory.'
            }
            Assert-AgentsChatStoppedHistoryHandoffLockSettlement $Context
        }
        return [ordered]@{
            status='lock-retirement-settled'; attemptId=$observed.attemptId
            previousOperationId=$observed.previousOperationId; project=$observed.project
            prepared=$observed.prepared; committed=$observed.committed; retirement=$observed.retirement
            terminal=$Context.HistoryHandoffLockSettlement.Descriptor
            lockIdentity=$observed.lockIdentity; lock=$observed.lock
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Lock settlement observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffLockSettlementObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $SuccessorAbandoned
) {
    $scope = $null
    try {
        if ($null -eq $Terminal) { throw 'Lock settlement descriptor is required.' }
        $scope = Open-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Control `
            $ControllerPid $ControllerIdentity $AttemptId $Prepared $Committed $Retirement `
            -Terminal $Terminal -Successor $Successor -SuccessorAbandoned $SuccessorAbandoned
        $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $scope $ControllerPid $ControllerIdentity
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Lock settlement observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Lock settlement observation failed; retain evidence.', $failure)
    }
}
