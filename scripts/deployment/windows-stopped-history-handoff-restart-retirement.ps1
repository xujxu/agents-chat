. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-committed-observation.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRestartOwnerAbsent([hashtable]$Context) {
    $request = $Context.HistoryHandoffRestartPrepared.Request
    $owner = $Context.HistoryHandoffRestartCommitted.Creator
    Assert-AgentsChatRetirementFields $owner @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($owner.pid -isnot [int] -or $owner.bridgePid -isnot [int] -or
        $owner.pid -ne $request.ControllerPid -or $owner.processIdentity -cne $request.ControllerIdentity) {
        throw 'Restart lock retirement owner differs from its committed creator.'
    }
    foreach ($pass in @(1, 2)) {
        try {
            Assert-AgentsChatCompletionProcessAbsent $owner.pid $owner.processIdentity
            Assert-AgentsChatCompletionProcessAbsent $owner.bridgePid $owner.bridgeIdentity
        } catch {
            throw [InvalidOperationException]::new('Restart lock owner remains live or unverifiable.', $_.Exception)
        }
    }
    return [ordered]@{
        pid=$owner.pid; processIdentity=$owner.processIdentity
        bridgePid=$owner.bridgePid; bridgeIdentity=$owner.bridgeIdentity
    }
}

function Get-AgentsChatStoppedHistoryHandoffRestartRetirementRecord([hashtable]$Context, $Creator, [string]$CreatedAt) {
    Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
    $observed = $Context.HistoryHandoffObservedCommit
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    if ($Creator.pid -ne $observed.ControllerPid -or $Creator.processIdentity -cne $observed.ControllerIdentity) {
        throw 'Restart lock retirement creator differs from its observer.'
    }
    $prepared = $Context.HistoryHandoffRestartPrepared
    $request = $prepared.Request
    $committed = $Context.HistoryHandoffRestartCommitted
    if ($Creator.processIdentity -ceq $request.ControllerIdentity -or $Creator.bridgeIdentity -ceq $committed.Creator.bridgeIdentity) {
        throw 'Restart lock retirement creator is not distinct from its owner.'
    }
    $owner = Assert-AgentsChatStoppedHistoryHandoffRestartOwnerAbsent $Context
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
    $state = Open-AgentsChatStoppedHistoryState $Context $record.state
    if ($state.ReadText() -cne $record.oldState) { throw 'Restart lock retirement original state differs.' }
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $committed.CommittedAt
    $parsed = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($parsed -gt [DateTimeOffset]::UtcNow) { throw 'Restart lock retirement is in the future.' }
    $lock = $Context.HistoryHandoffRestartLock
    return [ordered]@{
        version=1; phase='stopped-history-handoff-restart-lock-retirement-prepared'
        attemptId=$request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=$prepared.Descriptor; committed=$committed.Descriptor; newOwner=$record.newOwner
        lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor; state=$record.state
        owner=$owner; creator=$Creator; createdAt=$CreatedAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffRestartRetirement([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartRetirer') -or
        $Context.HistoryHandoffRestartRetirer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -or
        -not $Context.ContainsKey('HistoryHandoffRestartRetirement')) {
        throw 'Restart lock retirement lacks retained independent native proof.'
    }
    $retained = $Context.HistoryHandoffRestartRetirement
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('Time')) {
        throw 'Restart lock retirement lacks retained independent native proof.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-lock-retirement.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 65536
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Restart lock retirement descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartRetirementRecord $Context $retained.Creator $retained.Time
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 8 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
    $retained.File.Check()
}

function Publish-AgentsChatStoppedHistoryHandoffRestartRetirement(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartRetirer') -or
        $Context.HistoryHandoffRestartRetirer -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -or
        $Context.HistoryHandoffRestartCommittedObserver -ne $true) {
        throw 'Restart lock retirement requires its independent native role.'
    }
    try {
        if ($Context.Poisoned) { throw 'Restart lock retirement scope is poisoned.' }
        foreach ($key in @('HistoryHandoffRestartRetirement', 'HistoryHandoffRestartRelease', 'HistoryHandoffRestartReleased',
            'HistoryHandoffRestartReleaser', 'HistoryHandoffRestartCommitter', 'HistoryHandoffRestartStateIntent',
            'HistoryHandoffRestartStateIntender', 'HistoryHandoffRestartStateWriter', 'HistoryHandoffRestartStateStage',
            'HistoryHandoffRestartState')) {
            if ($Context.ContainsKey($key)) { throw 'Restart lock retirement scope already advanced.' }
        }
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock*').Length) {
            throw 'Restart lock retirement found a state stage.'
        }
        $null = Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Context $ControllerPid $ControllerIdentity
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $time = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffRestartRetirementRecord $Context $creator $time
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Restart lock retirement record is oversized.' }
        $name = "inactive-handoff-$($record.attemptId)-lock-retirement.json"
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($file)
        $Context.HistoryHandoffRestartRetirement = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name); Creator=$creator; Time=$time
        }
        foreach ($pass in @(1, 2)) {
            $null = Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffRestartRetirement $Context
            Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        }
        $lock = $Context.HistoryHandoffRestartLock
        return [ordered]@{
            status='restart-lock-retirement-prepared'; attemptId=$record.attemptId
            prepared=$record.prepared; committed=$record.committed
            retirement=$Context.HistoryHandoffRestartRetirement.Descriptor
            lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor; state=$record.state
            runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock retirement failed; retain evidence.', $_.Exception)
    }
}
