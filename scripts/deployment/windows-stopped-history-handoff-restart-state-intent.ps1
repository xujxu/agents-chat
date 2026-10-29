. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-commit.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartStateIntentRecord(
    [hashtable]$Context, $Creator, [string]$CreatedAt, [switch]$ObservedOwner
) {
    Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
    $observed = $Context.HistoryHandoffObservedCommit
    $prepared = $Context.HistoryHandoffRestartPrepared
    $request = $prepared.Request
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    if ($ObservedOwner) {
        if ($Creator.pid -ne $request.ControllerPid -or
            $Creator.processIdentity -cne $request.ControllerIdentity -or
            $Creator.pid -eq $observed.ControllerPid -or $Creator.bridgePid -eq $PID) {
            throw 'Restart state intent creator differs from its restart owner.'
        }
    } elseif ($Creator.pid -ne $observed.ControllerPid -or
        $Creator.processIdentity -cne $observed.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or
        $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Restart state intent creator differs from its actual publisher.'
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
    $committed = $Context.HistoryHandoffRestartCommitted
    $lock = $Context.HistoryHandoffRestartLock
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $committed.CommittedAt
    $time = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($time -gt [DateTimeOffset]::UtcNow) { throw 'Restart state intent is in the future.' }
    $state = Open-AgentsChatStoppedHistoryState $Context $record.state
    if ($state.ReadText() -cne $record.oldState) { throw 'Restart state intent original state differs.' }
    $old = [Text.Json.JsonDocument]::Parse($record.oldState)
    try {
        $root = $old.RootElement
        if ($root.GetProperty('operationId').GetString() -cne $Context.OperationId -or
            $root.GetProperty('project').GetString() -cne $Context.Project -or
            $record.newOwner.operationId -ceq $Context.OperationId) {
            throw 'Restart state intent original state identity differs.'
        }
    } finally { $old.Dispose() }
    $generation = [string]$record.observation.retiredRuntime.generation
    Assert-AgentsChatCompletionGuid $generation
    if ($record.operation -cne 'update') { throw 'Restart state intent operation differs.' }
    $nextState = [ordered]@{
        version=1; operationId=$record.newOwner.operationId; project=$Context.Project; operation=$record.operation
        phase='preflight'; previousPhase=$null; sourceCommit=$null; targetCommit=$null; backupId=$null
        priorRuntime='stopped'; runtimeIdentity=$generation
        startedAt=$record.newOwner.createdAt; updatedAt=$CreatedAt; errorCode=$null
    }
    return [ordered]@{
        version=1; phase='stopped-history-handoff-restart-state-intent'
        attemptId=$request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=$prepared.Descriptor; committed=$committed.Descriptor; newOwner=$record.newOwner
        lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
        state=$record.state; oldState=$record.oldState; nextState=$nextState
        creator=$Creator; createdAt=$CreatedAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent([hashtable]$Context) {
    $intender = $Context.ContainsKey('HistoryHandoffRestartStateIntender') -and
        $Context.HistoryHandoffRestartStateIntender -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        -not $Context.ContainsKey('HistoryHandoffRestartStateObserver')
    $observer = $Context.ContainsKey('HistoryHandoffRestartStateObserver') -and
        $Context.HistoryHandoffRestartStateObserver -eq $true -and
        $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -and
        $Context.HistoryHandoffRestartCommittedObserver -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartStateIntender')
    if ($intender -eq $observer -or -not $Context.ContainsKey('HistoryHandoffRestartStateIntent')) {
        throw 'Restart state intent lacks retained independent native proof.'
    }
    $retained = $Context.HistoryHandoffRestartStateIntent
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('CreatedAt')) {
        throw 'Restart state intent lacks retained independent native proof.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-state-intent.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 1048576
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) {
            throw 'Restart state intent descriptor differs.'
        }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartStateIntentRecord $Context $retained.Creator $retained.CreatedAt `
        -ObservedOwner:$observer
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

function Publish-AgentsChatStoppedHistoryHandoffRestartStateIntent(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartStateIntender') -or
        $Context.HistoryHandoffRestartStateIntender -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart state intent requires its independent native role.'
    }
    try {
        if ($Context.Poisoned) { throw 'Restart state intent scope is poisoned.' }
        if ($Context.ContainsKey('HistoryHandoffRestartStateIntent')) { throw 'Restart state intent already retained.' }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart state intent controller differs.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffRestartStateIntentRecord $Context $creator $createdAt
        $text = $record | ConvertTo-Json -Depth 12 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 1048576) { throw 'Restart state intent is oversized.' }
        $name = "inactive-handoff-$($record.attemptId)-state-intent.json"
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($file)
        $Context.HistoryHandoffRestartStateIntent = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name 1048576)
            Creator=$creator; CreatedAt=$createdAt
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
        return $Context.HistoryHandoffRestartStateIntent.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart state intent failed; retain evidence.', $_.Exception)
    }
}
