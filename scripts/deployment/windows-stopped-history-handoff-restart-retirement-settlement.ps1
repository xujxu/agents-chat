. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-retirement-directory.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementRecord([hashtable]$Context, $Creator, [string]$SettledAt) {
    $observed = $Context.HistoryHandoffObservedCommit
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    if ($Creator.pid -ne $observed.ControllerPid -or $Creator.processIdentity -cne $observed.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Restart lock settlement creator differs from its actual settler.'
    }
    $lock = $Context.HistoryHandoffRestartLock
    if (-not $lock.ContainsKey('DirectoryRetired') -or $lock.DirectoryRetired -ne $true) {
        throw 'Restart lock settlement requires its exact directory-retired stage.'
    }
    $retained = $Context.HistoryHandoffRestartRetirement
    $intent = Get-AgentsChatStoppedHistoryHandoffRestartRetirementRecord $Context $retained.Creator $retained.Time
    Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $SettledAt $retained.Time
    $parsed = [DateTimeOffset]::ParseExact($SettledAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($parsed -gt [DateTimeOffset]::UtcNow) { throw 'Restart lock settlement is in the future.' }
    return [ordered]@{
        version=1; phase='stopped-history-handoff-restart-lock-retired'
        attemptId=$intent.attemptId; control=$intent.control; project=$intent.project
        controlIdentity=$intent.controlIdentity; previousOperationId=$intent.previousOperationId
        prepared=$intent.prepared; committed=$intent.committed; retirement=$retained.Descriptor
        newOwner=$intent.newOwner; lockIdentity=$intent.lockIdentity; lock=$intent.lock; state=$intent.state
        owner=$intent.owner; retirer=$intent.creator; creator=$Creator; settledAt=$SettledAt
    }
}

function Assert-AgentsChatStoppedHistoryHandoffRestartLockSettlement([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartSettler') -or
        $Context.HistoryHandoffRestartSettler -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartSettlement')) {
        throw 'Restart lock settlement lacks retained independent native proof.'
    }
    $retained = $Context.HistoryHandoffRestartSettlement
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('Time')) {
        throw 'Restart lock settlement lacks retained independent native proof.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-lock-retired.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 65536
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Restart lock settlement descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementRecord $Context $retained.Creator $retained.Time
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

function Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementValue(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $value = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
    if ($value.status -cne 'restart-lock-retirement-directory-retired') {
        throw 'Restart lock settlement did not preserve its exact absent stage.'
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartLockSettlement $Context
    $value.status = 'restart-lock-settled'
    $value.settlement = $Context.HistoryHandoffRestartSettlement.Descriptor
    return $value
}

function Publish-AgentsChatStoppedHistoryHandoffRestartLockSettlement(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartSettler') -or
        $Context.HistoryHandoffRestartSettler -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -or
        $Context.HistoryHandoffRestartRetirementObserver -ne $true) {
        throw 'Restart lock settlement requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffRestartSettlement')) {
            return Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementValue $Context $ControllerPid $ControllerIdentity
        }
        $observed = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Context $ControllerPid $ControllerIdentity
        if ($observed.status -cne 'restart-lock-retirement-directory-retired') {
            throw 'Restart lock settlement requires complete native directory retirement.'
        }
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $time = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementRecord $Context $creator $time
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Restart lock settlement record is oversized.' }
        $name = "inactive-handoff-$($record.attemptId)-lock-retired.json"
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($file)
        $Context.HistoryHandoffRestartSettlement = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name); Creator=$creator; Time=$time
        }
        foreach ($pass in @(1, 2)) {
            $value = Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementValue $Context $ControllerPid $ControllerIdentity
        }
        return $value
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock settlement failed; retain evidence.', $_.Exception)
    }
}
