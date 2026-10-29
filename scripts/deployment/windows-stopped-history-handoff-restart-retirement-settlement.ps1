. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-retirement-directory.ps1')

function Test-AgentsChatRestartLockSettlerCurrent($Creator, [int]$ControllerPid, [string]$ControllerIdentity) {
    return $Creator.pid -eq $ControllerPid -and $Creator.processIdentity -ceq $ControllerIdentity -and
        $Creator.bridgePid -eq $PID -and $Creator.bridgeIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
}

function Assert-AgentsChatRestartLockSettler($Creator, [int]$ControllerPid, [string]$ControllerIdentity) {
    Assert-AgentsChatRetirementFields $Creator @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($Creator.pid -isnot [int] -or $Creator.bridgePid -isnot [int] -or $Creator.pid -eq $Creator.bridgePid) {
        throw 'Invalid restart lock settler.'
    }
    if ($Creator.pid -ne $ControllerPid -or $Creator.processIdentity -cne $ControllerIdentity) {
        Assert-AgentsChatRetirementCreator $Creator $ControllerPid $ControllerIdentity
        return
    }
    # The settling controller may outlive its bridge; only a current or dead settler bridge is accepted.
    Assert-AgentsChatCompletionProcessIdentity $Creator.bridgePid $Creator.bridgeIdentity
    if (-not (Test-AgentsChatRestartLockSettlerCurrent $Creator $ControllerPid $ControllerIdentity)) {
        Assert-AgentsChatCompletionProcessAbsent $Creator.bridgePid $Creator.bridgeIdentity
    }
}

function Get-AgentsChatStoppedHistoryHandoffRestartLockSettlementRecord([hashtable]$Context, $Creator, [string]$SettledAt) {
    $observed = $Context.HistoryHandoffObservedCommit
    Assert-AgentsChatRestartLockSettler $Creator $observed.ControllerPid $observed.ControllerIdentity
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
    $settler = $Context.ContainsKey('HistoryHandoffRestartSettler') -and $Context.HistoryHandoffRestartSettler -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffRestartSettlementObserver') -and
        $Context.HistoryHandoffRestartSettlementObserver -eq $true
    if (-not ($settler -or $observer) -or -not $Context.ContainsKey('HistoryHandoffRestartSettlement')) {
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
    if ($value.status -cne 'restart-lock-settled') {
        throw 'Restart lock settlement did not preserve its exact absent stage.'
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartLockSettlement $Context
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
            $retained = $Context.HistoryHandoffRestartSettlement
            if ($Context.ContainsKey('HistoryHandoffRestartSettlementObserver') -or
                -not (Test-AgentsChatRestartLockSettlerCurrent $retained.Creator $ControllerPid $ControllerIdentity)) {
                throw 'Fresh restart lock settler cannot replace an observed settlement.'
            }
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

function Initialize-AgentsChatStoppedHistoryHandoffRestartLockSettlementObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -or
        $Context.HistoryHandoffRestartRetirementObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartSettlement') -or
        $Context.ContainsKey('HistoryHandoffRestartSettler') -or
        $Context.ContainsKey('HistoryHandoffRestartSettlementObserver')) {
        throw 'Restart lock settlement observation bootstrap differs.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-lock-retired.json"
    $file = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($file.ReadText())
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'retirement', 'newOwner', 'lockIdentity', 'lock', 'state', 'owner', 'retirer',
        'creator', 'settledAt'
    )
    if ($record.phase -cne 'stopped-history-handoff-restart-lock-retired' -or $record.settledAt -isnot [string]) {
        throw 'Restart lock settlement observation phase differs.'
    }
    $Context.HistoryHandoffRestartSettlement = @{
        File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name)
        Creator=$record.creator; Time=$record.settledAt
    }
    $Context.HistoryHandoffRestartSettlementObserver = $true
    Assert-AgentsChatStoppedHistoryHandoffRestartLockSettlement $Context
}
