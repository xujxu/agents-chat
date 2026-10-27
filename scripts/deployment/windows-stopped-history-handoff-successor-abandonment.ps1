. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedRecord(
    [hashtable]$Context, $Creator, [string]$SettledAt
) {
    $publisher = $Context.ContainsKey('HistoryHandoffSuccessorAbandoner') -and
        $Context.HistoryHandoffSuccessorAbandoner -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver')
    $reader = $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver') -and
        $Context.HistoryHandoffSuccessorAbandonedObserver -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffSuccessorAbandoner')
    if ($publisher -eq $reader -or
        -not $Context.ContainsKey('HistoryHandoffSuccessorObserver') -or
        $Context.HistoryHandoffSuccessorObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffSuccessorPreparer') -or
        $Context.ContainsKey('HistoryHandoffSuccessorPublisher')) {
        throw 'Successor abandonment lacks independent dead-owner proof.'
    }
    Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
    $observer = $Context.HistoryHandoffObservedCommit
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($observer.ControllerPid) -cne $observer.ControllerIdentity) {
        throw 'Successor abandonment controller differs.'
    }
    Assert-AgentsChatRetirementCreator $Creator $observer.ControllerPid $observer.ControllerIdentity
    if ($reader) {
        Assert-AgentsChatCompletionProcessAbsent $Creator.pid $Creator.processIdentity
        Assert-AgentsChatCompletionProcessAbsent $Creator.bridgePid $Creator.bridgeIdentity
    } elseif ($Creator.pid -ne $observer.ControllerPid -or
        $Creator.processIdentity -cne $observer.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or
        $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Successor abandonment creator differs from its actual publisher.'
    }
    $prepared = $Context.HistoryHandoffSuccessorPrepared
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $SettledAt $prepared.Request.CreatedAt
    return [ordered]@{
        version=1; phase='stopped-history-handoff-successor-abandoned'
        attemptId=$prepared.Request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared.File $prepared.Descriptor.path 1048576)
        creator=$Creator; settledAt=$SettledAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorAbandoned')) {
        throw 'Successor abandonment lacks its retained terminal.'
    }
    $retained = $Context.HistoryHandoffSuccessorAbandoned
    $name = "inactive-handoff-$($Context.HistoryHandoffSuccessorPrepared.Request.AttemptId)-abandoned.json"
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Successor abandonment descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedRecord $Context $retained.Creator $retained.SettledAt
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 8 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}

function Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorAbandoner') -or
        $Context.HistoryHandoffSuccessorAbandoner -ne $true -or
        $Context.ContainsKey('HistoryHandoffSuccessorAbandonedObserver')) {
        throw 'Successor abandonment requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffSuccessorAbandoned')) { throw 'Successor abandonment already retained.' }
        $observed = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $Context $ControllerPid $ControllerIdentity
        if ($observed.status -cne 'successor-prepared-observed') {
            throw 'Successor abandonment requires an independent dead-owner observation.'
        }
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $settledAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedRecord $Context $creator $settledAt
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Successor abandonment terminal is oversized.' }
        $name = "inactive-handoff-$($observed.attemptId)-abandoned.json"
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($held)
        $Context.HistoryHandoffSuccessorAbandoned = @{
            File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
            Creator=$creator; SettledAt=$settledAt
        }
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $Context
        return $Context.HistoryHandoffSuccessorAbandoned.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Successor abandonment failed; retain evidence.', $_.Exception)
    }
}
