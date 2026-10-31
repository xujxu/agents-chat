. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-committed-observation.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-state-intent.ps1')

function Get-AgentsChatStoppedHistoryHandoffObservedStateIntentRecord([hashtable]$Context, $Creator, [string]$CreatedAt) {
    $observed = $Context.HistoryHandoffObservedCommit
    $record = Read-AgentsChatRetirementJson ($observed.Prepared.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-prepared' -or
        $record.attemptId -cne $observed.AttemptId) {
        throw 'Handoff state observation prepared template differs.'
    }
    Assert-AgentsChatStoppedHistoryHandoffObservedCreator $Context $Creator $observed.ControllerPid $observed.ControllerIdentity
    $admitter = Test-AgentsChatStoppedHistoryHandoffFirstOwnerAdmitter $Context
    if ($Creator.pid -ne $record.newOwner.pid -or
        $Creator.processIdentity -cne $record.newOwner.processIdentity -or
        $Creator.pid -ne $observed.Creator.pid -or
        $Creator.processIdentity -cne $observed.Creator.processIdentity -or
        (-not $admitter -and $Creator.processIdentity -ceq $observed.ControllerIdentity) -or
        $Creator.bridgeIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Handoff state observation creator differs from its committed owner.'
    }
    $lock = $Context.HistoryHandoffLock
    return Get-AgentsChatStoppedHistoryHandoffStateIntentBody $Context @{
        Label='Handoff state observation'; Phase='stopped-history-handoff-state-intent'
        AttemptId=$observed.AttemptId; Prepared=$observed.PreparedDescriptor
        Committed=$observed.CommittedDescriptor; CommittedAt=$observed.CommittedAt
        LockIdentity=$lock.DirectoryIdentity; Lock=$lock.OwnerDescriptor; Record=$record
    } $Creator $CreatedAt
}

function Assert-AgentsChatStoppedHistoryHandoffObservedStateIntent([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffStateObserver') -or
        $Context.HistoryHandoffStateObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffLockObserver') -or
        $Context.HistoryHandoffLockObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.ContainsKey('HistoryHandoffStateIntent') -or
        -not $Context.ContainsKey('HistoryHandoffObservedStateIntent') -or
        -not $Context.ContainsKey('HistoryStateTransition')) {
        throw 'Handoff state observation lacks retained independent native proof.'
    }
    $retained = $Context.HistoryHandoffObservedStateIntent
    if ($retained -isnot [hashtable] -or $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not [object]::ReferenceEquals($retained.File, $Context.HistoryStateTransition.Intent) -or
        -not $Context.Files.Contains($retained.File)) {
        throw 'Handoff state observation lacks retained independent native proof.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffObservedCommit.AttemptId)-state-intent.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 1048576
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field] -or
            $descriptor[$field] -cne $Context.HistoryStateTransition.IntentDescriptor[$field]) {
            throw 'Handoff state observation intent descriptor differs.'
        }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffObservedStateIntentRecord $Context $retained.Creator $retained.CreatedAt
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 12 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
    $retained.File.Check()
}

function Assert-AgentsChatStoppedHistoryHandoffStateObserved([hashtable]$Context) {
    Assert-AgentsChatStoppedHistoryHandoffObservedStateIntent $Context
    $transition = $Context.HistoryStateTransition
    $retained = $Context.HistoryHandoffObservedState
    if ($retained -isnot [hashtable] -or -not [object]::ReferenceEquals($retained.File, $transition.Written) -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or -not $Context.Files.Contains($retained.File)) {
        throw 'Handoff state observation lacks retained independent native proof.'
    }
    Assert-AgentsChatStoppedHistoryStateTransition $Context
    $document = [Text.Json.JsonDocument]::Parse($Context.HistoryHandoffObservedStateIntent.File.ReadText())
    try { $text = $document.RootElement.GetProperty('nextState').GetRawText() + "`n" }
    finally { $document.Dispose() }
    if ($text -cne $transition.NextText -or $retained.File.ReadText() -cne $text) {
        throw 'Handoff state observation written state differs from its intent.'
    }
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File 'state.json'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field] -or
            $descriptor[$field] -cne $transition.WrittenDescriptor[$field]) {
            throw 'Handoff state observation descriptor differs.'
        }
    }
    foreach ($pattern in @('state.json.lock', 'state.json.lock.pending-*')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
            throw 'Handoff state observation found a retained stage.'
        }
    }
}

function Initialize-AgentsChatStoppedHistoryHandoffStateObservation([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryStateTransition') -or
        $Context.HistoryStateTransition.FirstAttempt -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffLockObserver') -or
        $Context.HistoryHandoffLockObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.ContainsKey('HistoryHandoffStateIntent') -or
        $Context.ContainsKey('HistoryHandoffState') -or
        $Context.ContainsKey('HistoryHandoffObservedStateIntent') -or
        $Context.ContainsKey('HistoryHandoffObservedState')) {
        throw 'Handoff state observation bootstrap differs.'
    }
    $transition = $Context.HistoryStateTransition
    if ($transition.AttemptId -cne $Context.HistoryHandoffObservedCommit.AttemptId) {
        throw 'Handoff state observation attempt differs.'
    }
    # nextState legitimately carries null phase fields; the full record is re-verified by the intent assertion below.
    $record = Read-AgentsChatRetirementJson ($transition.Intent.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'state', 'oldState', 'nextState',
        'creator', 'createdAt'
    )
    if ($record.createdAt -isnot [string]) { throw 'Handoff state observation timestamp differs.' }
    $name = "inactive-handoff-$($transition.AttemptId)-state-intent.json"
    $Context.HistoryHandoffObservedStateIntent = @{
        File=$transition.Intent; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $transition.Intent $name 1048576)
        Creator=$record.creator; CreatedAt=$record.createdAt
    }
    $Context.HistoryHandoffStateObserver = $true
    $Context.HistoryHandoffObservedState = @{
        File=$transition.Written; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $transition.Written 'state.json')
    }
    Assert-AgentsChatStoppedHistoryHandoffStateObserved $Context
}

function Get-AgentsChatStoppedHistoryHandoffStateObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if ($Context.ContainsKey('HistoryHandoffLockPublisher')) {
            throw 'Handoff state observation requires its independent native role.'
        }
        Assert-AgentsChatStoppedHistoryHandoffStateObserved $Context
        $committed = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffStateObserved $Context
        return [ordered]@{
            status='committed-handoff-state-observed'; attemptId=$committed.attemptId
            previousOperationId=$committed.previousOperationId; project=$committed.project
            prepared=$committed.prepared; committed=$committed.committed
            stateIntent=$Context.HistoryHandoffObservedStateIntent.Descriptor
            state=$Context.HistoryHandoffObservedState.Descriptor
            lockIdentity=$committed.lockIdentity; lock=$committed.lock
            runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff state observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffStateObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $StateIntent, $State, [switch]$OwnerAdmission
) {
    $scope = $null
    try {
        if ($null -eq $StateIntent -or $null -eq $State) { throw 'Handoff state observation descriptors are required.' }
        $request = @{
            attemptId=$AttemptId; prepared=$Prepared; committed=$Committed
            controllerPid=$ControllerPid; controllerIdentity=$ControllerIdentity
            stateIntent=$StateIntent; state=$State
        }
        if ($OwnerAdmission) { $request.firstOwnerAdmission = $true }
        $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive -HistoryHandoffObservation $request
        $null = Get-AgentsChatStoppedHistoryHandoffStateObservation $scope $ControllerPid $ControllerIdentity
        return $scope
    } catch {
        $failure = $_.Exception
        if ($scope) {
            try { Close-AgentsChatTaskCompletionProof $scope }
            catch { $failure = [AggregateException]::new('Handoff state observation open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        }
        throw [InvalidOperationException]::new('Handoff state observation failed; retain evidence.', $failure)
    }
}
