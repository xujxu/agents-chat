. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-owner.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartCommittedRecord(
    [hashtable]$Context, $Creator, [string]$CommittedAt, [switch]$ObservedOwner
) {
    Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
    $observed = $Context.HistoryHandoffObservedCommit
    $prepared = $Context.HistoryHandoffRestartPrepared
    $request = $prepared.Request
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    if ($ObservedOwner) {
        if ($Creator.pid -ne $request.ControllerPid -or
            $Creator.processIdentity -cne $request.ControllerIdentity -or
            $Creator.pid -eq $observed.ControllerPid -or $Creator.bridgePid -eq $PID) {
            throw 'Restart committed creator differs from its restart owner.'
        }
    } elseif ($Creator.pid -ne $observed.ControllerPid -or
        $Creator.processIdentity -cne $observed.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or
        $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Restart committed creator differs from its actual publisher.'
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
    $lock = $Context.HistoryHandoffRestartLock
    if (-not $lock.ContainsKey('OwnerFile') -or -not $lock.ContainsKey('OwnerDescriptor')) {
        throw 'Restart commitment requires its actual published owner.'
    }
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CommittedAt $request.CreatedAt
    $time = [DateTimeOffset]::ParseExact($CommittedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($time -gt [DateTimeOffset]::UtcNow) { throw 'Restart commitment is in the future.' }
    return [ordered]@{
        version=1; phase='stopped-history-handoff-restart-committed'
        attemptId=$request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=$prepared.Descriptor; newOwner=$record.newOwner
        lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
        creator=$Creator; committedAt=$CommittedAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffRestartCommitted([hashtable]$Context) {
    $committer = $Context.ContainsKey('HistoryHandoffRestartCommitter') -and
        $Context.HistoryHandoffRestartCommitter -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        -not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver')
    $observer = $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -and
        $Context.HistoryHandoffRestartCommittedObserver -eq $true -and
        $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        $Context.HistoryHandoffRestartObserver -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartCommitter')
    if ($committer -eq $observer -or -not $Context.ContainsKey('HistoryHandoffRestartCommitted')) {
        throw 'Restart committed record lacks retained independent native proof.'
    }
    $retained = $Context.HistoryHandoffRestartCommitted
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('CommittedAt')) {
        throw 'Restart committed record lacks retained independent native proof.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-committed.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 65536
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) {
            throw 'Restart committed descriptor differs.'
        }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartCommittedRecord $Context $retained.Creator $retained.CommittedAt `
        -ObservedOwner:$observer
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

function Complete-AgentsChatStoppedHistoryHandoffRestartCommit(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartCommitter') -or
        $Context.HistoryHandoffRestartCommitter -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart commitment requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffRestartCommitted')) { throw 'Restart commitment already retained.' }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart commitment controller differs.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $committedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffRestartCommittedRecord $Context $creator $committedAt
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Restart commitment is oversized.' }
        $name = "inactive-handoff-$($record.attemptId)-committed.json"
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($file)
        $Context.HistoryHandoffRestartCommitted = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name)
            Creator=$creator; CommittedAt=$committedAt
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        return $Context.HistoryHandoffRestartCommitted.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart commitment failed; retain evidence.', $_.Exception)
    }
}
