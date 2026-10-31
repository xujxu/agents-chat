. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-committed-observation.ps1')

function Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime([string]$CreatedAt, [string]$CommittedAt) {
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $created = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    $committed = [DateTimeOffset]::ParseExact($CommittedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    if ($created -lt $committed -or $created.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $culture) -cne $CreatedAt) {
        throw 'Lock retirement preparation predates commitment.'
    }
}

function Get-AgentsChatStoppedHistoryHandoffLockRetirementIntentRecord(
    [hashtable]$Context, $Creator, [string]$CreatedAt
) {
    $retained = $Context.HistoryHandoffObservedCommit
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($retained.ControllerPid) -cne $retained.ControllerIdentity) {
        throw 'Lock retirement observer identity differs.'
    }
    Assert-AgentsChatRetirementCreator $Creator $retained.ControllerPid $retained.ControllerIdentity
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $CreatedAt $retained.CommittedAt
    $lock = $Context.HistoryHandoffLock
    $request = $lock.OwnerRequest
    $owner = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
    $ownerDescriptor = $lock.OwnerDescriptor
    if ($null -ne $lock.OwnerFile) {
        $ownerDescriptor = Get-AgentsChatStoppedHandoffDescriptor $lock.OwnerFile 'lock\owner.json'
    }
    return [ordered]@{
        version=1; phase='stopped-history-handoff-lock-retirement-prepared'
        attemptId=$retained.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=(Get-AgentsChatStoppedHandoffDescriptor $retained.Prepared $retained.PreparedName 1048576)
        committed=(Get-AgentsChatStoppedHandoffDescriptor $retained.Committed $retained.CommittedName)
        newOwner=$owner; lockIdentity=$lock.DirectoryIdentity
        lock=$ownerDescriptor
        creator=$Creator; createdAt=$CreatedAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent([hashtable]$Context) {
    $retirer = $Context.ContainsKey('HistoryHandoffLockRetirer') -and $Context.HistoryHandoffLockRetirer -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -and
        $Context.HistoryHandoffLockRetirementObserver -eq $true
    if ($retirer -eq $observer -or
        -not $Context.ContainsKey('HistoryHandoffLockObserver') -or
        $Context.HistoryHandoffLockObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffObservedCommit') -or
        -not $Context.ContainsKey('HistoryHandoffLockRetirementIntent')) {
        throw 'Lock retirement intent lacks retained native proof.'
    }
    $intent = $Context.HistoryHandoffLockRetirementIntent
    $name = "inactive-handoff-$($Context.HistoryHandoffObservedCommit.AttemptId)-lock-retirement.json"
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $intent.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $intent.Descriptor[$field]) { throw 'Lock retirement intent descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffLockRetirementIntentRecord $Context $intent.Creator $intent.CreatedAt
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($intent.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 8 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}

function Publish-AgentsChatStoppedHistoryHandoffLockRetirementIntent(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockRetirer') -or $Context.HistoryHandoffLockRetirer -ne $true) {
        throw 'Handoff lock retirement preparation requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffLockRetirementIntent')) { throw 'Lock retirement intent already retained.' }
        $null = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $Context $ControllerPid $ControllerIdentity
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffLockRetirementIntentRecord $Context $creator $createdAt
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        $name = "inactive-handoff-$($Context.HistoryHandoffObservedCommit.AttemptId)-lock-retirement.json"
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($held)
        $Context.HistoryHandoffLockRetirementIntent = @{
            File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
            Creator=$creator; CreatedAt=$createdAt
        }
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $null = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
        }
        return $Context.HistoryHandoffLockRetirementIntent.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff lock retirement preparation failed; retain evidence.', $_.Exception)
    }
}
