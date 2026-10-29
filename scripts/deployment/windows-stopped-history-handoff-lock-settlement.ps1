. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-lock-retirement-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffLockSettlementRecord(
    [hashtable]$Context, $Creator, [string]$SettledAt
) {
    $retained = $Context.HistoryHandoffObservedCommit
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($retained.ControllerPid) -cne $retained.ControllerIdentity) {
        throw 'Lock settlement observer identity differs.'
    }
    Assert-AgentsChatRetirementCreator $Creator $retained.ControllerPid $retained.ControllerIdentity
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementIntent $Context
    $lock = $Context.HistoryHandoffLock
    if (-not $lock.DirectoryRetired -or -not $lock.OwnerRetired -or
        $null -ne $lock.Directory -or $null -ne $lock.DirectoryRetirement -or
        $null -ne $lock.OwnerFile -or $null -ne $lock.OwnerRetirement) {
        throw 'Lock settlement requires its exact directory-retired stage.'
    }
    $intent = $Context.HistoryHandoffLockRetirementIntent
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $SettledAt $intent.CreatedAt
    $request = $lock.OwnerRequest
    $owner = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
    return [ordered]@{
        version=1; phase='stopped-history-handoff-lock-retired'; attemptId=$retained.AttemptId
        control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity; previousOperationId=$Context.OperationId
        prepared=(Get-AgentsChatStoppedHandoffDescriptor $retained.Prepared $retained.PreparedName 1048576)
        committed=(Get-AgentsChatStoppedHandoffDescriptor $retained.Committed $retained.CommittedName)
        retirement=(Get-AgentsChatStoppedHandoffDescriptor $intent.File $intent.Descriptor.path)
        newOwner=$owner; lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor
        creator=$Creator; settledAt=$SettledAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffLockSettlement([hashtable]$Context) {
    $publisher = $Context.ContainsKey('HistoryHandoffLockSettler') -and $Context.HistoryHandoffLockSettler -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffLockSettlementObserver') -and
        $Context.HistoryHandoffLockSettlementObserver -eq $true
    if ($publisher -eq $observer -or
        -not $Context.ContainsKey('HistoryHandoffLockRetirementObserver') -or
        $Context.HistoryHandoffLockRetirementObserver -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffLockSettlement')) {
        throw 'Lock settlement lacks retained independent native proof.'
    }
    $settlement = $Context.HistoryHandoffLockSettlement
    $name = "inactive-handoff-$($Context.HistoryHandoffObservedCommit.AttemptId)-lock-retired.json"
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $settlement.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $settlement.Descriptor[$field]) { throw 'Lock settlement descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffLockSettlementRecord $Context $settlement.Creator $settlement.SettledAt
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($settlement.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 8 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}

function Publish-AgentsChatStoppedHistoryHandoffLockSettlement(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockSettler') -or $Context.HistoryHandoffLockSettler -ne $true) {
        throw 'Handoff lock settlement requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffLockSettlement')) { throw 'Lock settlement already retained.' }
        $observed = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
        if ($observed.status -cne 'lock-retirement-directory-retired') {
            throw 'Lock settlement requires complete native directory retirement.'
        }
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $settledAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffLockSettlementRecord $Context $creator $settledAt
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        $name = "inactive-handoff-$($Context.HistoryHandoffObservedCommit.AttemptId)-lock-retired.json"
        $held = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control $name), ($record | ConvertTo-Json -Depth 8 -Compress))
        $Context.Files.Add($held)
        $Context.HistoryHandoffLockSettlement = @{
            File=$held; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $held $name)
            Creator=$creator; SettledAt=$settledAt
        }
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            $null = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffLockSettlement $Context
        }
        return $Context.HistoryHandoffLockSettlement.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff lock settlement failed; retain evidence.', $_.Exception)
    }
}
