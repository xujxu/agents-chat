. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-committed-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-state-write.ps1')

function Initialize-AgentsChatStoppedHistoryHandoffRestartStateObservation([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryStateTransition') -or
        -not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -or
        $Context.HistoryHandoffRestartCommittedObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartStateIntent') -or
        $Context.ContainsKey('HistoryHandoffRestartStateIntender') -or
        $Context.ContainsKey('HistoryHandoffRestartState') -or
        $Context.ContainsKey('HistoryHandoffRestartStateWriter')) {
        throw 'Restart state observation bootstrap differs.'
    }
    $transition = $Context.HistoryStateTransition
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-state-intent.json"
    if ($transition.AttemptId -cne $Context.HistoryHandoffRestartPrepared.Request.AttemptId) {
        throw 'Restart state observation attempt differs.'
    }
    # nextState legitimately carries null phase fields; the full record is re-verified by the intent assertion below.
    $record = Read-AgentsChatRetirementJson ($transition.Intent.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'state', 'oldState', 'nextState',
        'creator', 'createdAt'
    )
    if ($record.createdAt -isnot [string]) { throw 'Restart state observation timestamp differs.' }
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $transition.Intent $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $transition.IntentDescriptor[$field]) { throw 'Restart state intent descriptor differs.' }
    }
    $Context.HistoryHandoffRestartStateIntent = @{
        File=$transition.Intent; Descriptor=$descriptor; Creator=$record.creator; CreatedAt=$record.createdAt
    }
    $Context.HistoryHandoffRestartStateObserver = $true
    Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
    $Context.HistoryHandoffRestartState = @{
        File=$transition.Written; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $transition.Written 'state.json')
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartStateObserved $Context
}

function Assert-AgentsChatStoppedHistoryHandoffRestartStateObserved([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartStateObserver') -or
        $Context.HistoryHandoffRestartStateObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartState') -or
        -not $Context.ContainsKey('HistoryStateTransition')) {
        throw 'Restart state observation lacks retained independent native proof.'
    }
    $transition = $Context.HistoryStateTransition
    $retained = $Context.HistoryHandoffRestartState
    if (-not [object]::ReferenceEquals($retained.File, $transition.Written) -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or -not $Context.Files.Contains($retained.File)) {
        throw 'Restart state observation lacks retained independent native proof.'
    }
    Assert-AgentsChatStoppedHistoryStateTransition $Context
    $text = Get-AgentsChatStoppedHistoryHandoffRestartStateText $Context
    if ($text -cne $transition.NextText -or $retained.File.ReadText() -cne $text) {
        throw 'Restart state observation written state differs from its ninth record.'
    }
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File 'state.json'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field] -or
            $descriptor[$field] -cne $transition.WrittenDescriptor[$field]) {
            throw 'Restart state observation descriptor differs.'
        }
    }
    foreach ($pattern in @('state.json.lock', 'state.json.lock.pending-*')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
            throw 'Restart state observation found a retained stage.'
        }
    }
}

function Get-AgentsChatStoppedHistoryHandoffRestartStateObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if ($Context.ContainsKey('HistoryHandoffRestartStateIntender') -or
            $Context.ContainsKey('HistoryHandoffRestartStateWriter')) {
            throw 'Restart state observation requires its independent native role.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartStateObserved $Context
        $committed = Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartStateObserved $Context
        return [ordered]@{
            status='restart-state-observed'; attemptId=$committed.attemptId
            previousAttemptId=$committed.previousAttemptId; previousOperationId=$committed.previousOperationId
            project=$committed.project; prepared=$committed.prepared; committed=$committed.committed
            stateIntent=$Context.HistoryHandoffRestartStateIntent.Descriptor
            state=$Context.HistoryHandoffRestartState.Descriptor
            lockIdentity=$committed.lockIdentity; lock=$committed.lock
            runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart state observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffRestartStateObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $Abandoned, $Restart,
    $RestartCommitted, $RestartStateIntent, $RestartState, [switch]$OwnerAdmission
) {
    try {
        if ($null -eq $RestartCommitted -or $null -eq $RestartStateIntent -or $null -eq $RestartState) {
            throw 'Restart state observation descriptors are required.'
        }
        return Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
            $AttemptId $Prepared $Committed $Retirement $Terminal $Successor $Abandoned $Restart $RestartCommitted `
            $RestartStateIntent $RestartState -OwnerAdmission:$OwnerAdmission
    } catch {
        throw [InvalidOperationException]::new('Restart state observation failed; retain evidence.', $_.Exception)
    }
}
