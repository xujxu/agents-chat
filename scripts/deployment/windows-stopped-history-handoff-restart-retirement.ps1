. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-committed-observation.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRestartOwnerAbsent([hashtable]$Context) {
    $request = $Context.HistoryHandoffRestartPrepared.Request
    $owner = $Context.HistoryHandoffRestartCommitted.Creator
    Assert-AgentsChatRetirementFields $owner @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
    if ($owner.pid -isnot [int] -or $owner.bridgePid -isnot [int] -or
        $owner.pid -ne $request.ControllerPid -or $owner.processIdentity -cne $request.ControllerIdentity) {
        throw 'Restart lock retirement owner differs from its committed creator.'
    }
    foreach ($pass in (Get-AgentsChatVerificationPasses)) {
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
    # A creator other than this controller and bridge must be absent; only the live retirer may record itself.
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    $self = $Creator.pid -eq $observed.ControllerPid -and $Creator.processIdentity -ceq $observed.ControllerIdentity
    if ($Context.ContainsKey('HistoryHandoffRestartRetirementObserver')) {
        if ($self -or $Creator.bridgeIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) { throw 'Restart lock retirement observer is its recorded retirer.' }
    } elseif (-not $self) {
        throw 'Restart lock retirement creator differs from its observer.'
    }
    $prepared = $Context.HistoryHandoffRestartPrepared
    $request = $prepared.Request
    $committed = $Context.HistoryHandoffRestartCommitted
    $release = $Context.ContainsKey('HistoryHandoffRestartRetirement') -and
        $Context.HistoryHandoffRestartRetirement -is [hashtable] -and
        $Context.HistoryHandoffRestartRetirement.ContainsKey('Release') -and $Context.HistoryHandoffRestartRetirement.Release -eq $true
    if ($release) {
        # A dead live releaser's exact tenth record names the committed owner itself as its creator.
        if (-not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver')) {
            throw 'Restart release intent takeover requires its independent observer.'
        }
        foreach ($field in @('pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')) {
            if ($Creator[$field] -cne $committed.Creator[$field]) { throw 'Restart release intent creator differs from its committed owner.' }
        }
    } elseif ($Creator.processIdentity -ceq $request.ControllerIdentity -or $Creator.bridgeIdentity -ceq $committed.Creator.bridgeIdentity) {
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
    $value = [ordered]@{
        version=1
        phase=$(if ($release) { 'stopped-history-handoff-restart-release-prepared' } else { 'stopped-history-handoff-restart-lock-retirement-prepared' })
        attemptId=$request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=$prepared.Descriptor; committed=$committed.Descriptor; newOwner=$record.newOwner
        lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor; state=$record.state
    }
    if (-not $release) { $value.owner = $owner }
    $value.creator = $Creator
    $value.createdAt = $CreatedAt
    return $value
}

function Assert-AgentsChatStoppedHistoryHandoffRestartRetirement([hashtable]$Context) {
    $retirer = $Context.ContainsKey('HistoryHandoffRestartRetirer') -and $Context.HistoryHandoffRestartRetirer -eq $true
    $observer = $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -and
        $Context.HistoryHandoffRestartRetirementObserver -eq $true
    if ($retirer -eq $observer -or
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
        foreach ($key in @('HistoryHandoffRestartRetirement', 'HistoryHandoffRestartRetirementObserver', 'HistoryHandoffRestartRelease', 'HistoryHandoffRestartReleased',
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
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
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

function Initialize-AgentsChatStoppedHistoryHandoffRestartRetirementObservation([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartCommittedObserver') -or
        $Context.HistoryHandoffRestartCommittedObserver -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartRetirement') -or
        $Context.ContainsKey('HistoryHandoffRestartRetirer') -or
        $Context.ContainsKey('HistoryHandoffRestartRetirementObserver')) {
        throw 'Restart lock retirement observation bootstrap differs.'
    }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-lock-retirement.json"
    $file = Open-AgentsChatRetirementFile $Context $Descriptor $name
    $record = Read-AgentsChatRetirementJson ($file.ReadText())
    $release = $record.phase -ceq 'stopped-history-handoff-restart-release-prepared'
    if ($release -and $record.Contains('stateIntent')) {
        # After the acknowledged state write, archive-only dead-owner cleanup is never valid.
        throw 'Post-write restart release takeover requires new-operation recovery.'
    }
    Assert-AgentsChatRetirementFields $record (@(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
        'prepared', 'committed', 'newOwner', 'lockIdentity', 'lock', 'state') +
        @($(if (-not $release) { 'owner' })) + @('creator', 'createdAt'))
    if (($record.phase -cne 'stopped-history-handoff-restart-lock-retirement-prepared' -and -not $release) -or
        $record.createdAt -isnot [string]) {
        throw 'Restart lock retirement observation phase differs.'
    }
    $Context.HistoryHandoffRestartRetirement = @{
        File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name)
        Creator=$record.creator; Time=$record.createdAt
    }
    if ($release) { $Context.HistoryHandoffRestartRetirement.Release = $true }
    $Context.HistoryHandoffRestartRetirementObserver = $true
    $null = $Context.Remove('HistoryHandoffRestartOwnerRetiredPending')
    Assert-AgentsChatStoppedHistoryHandoffRestartRetirement $Context
}

function Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        if (-not $Context.ContainsKey('HistoryHandoffRestartRetirementObserver') -or
            $Context.HistoryHandoffRestartRetirementObserver -ne $true -or
            $Context.ContainsKey('HistoryHandoffRestartRetirer')) {
            throw 'Restart lock retirement observation requires its independent native role.'
        }
        if ($Context.Poisoned) { throw 'Restart lock retirement observation scope is poisoned.' }
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock*').Length) {
                throw 'Restart lock retirement observation found a state stage.'
            }
            $null = Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffRestartRetirement $Context
            Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        }
        $retained = $Context.HistoryHandoffRestartRetirement
        $record = Get-AgentsChatStoppedHistoryHandoffRestartRetirementRecord $Context $retained.Creator $retained.Time
        $lock = $Context.HistoryHandoffRestartLock
        $status = if ($lock.ContainsKey('DirectoryRetired')) { 'restart-lock-retirement-directory-retired' }
            elseif ($lock.ContainsKey('OwnerRetired')) { 'restart-lock-retirement-owner-retired' }
            else { 'restart-lock-retirement-observed' }
        $value = [ordered]@{
            status=$status; attemptId=$record.attemptId
            prepared=$record.prepared; committed=$record.committed; retirement=$retained.Descriptor
            lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor; state=$record.state
            owner=$(if ($record.Contains('owner')) { $record.owner } else { $record.creator }); retirer=$record.creator
            runtimeAuthority=$false; lockAuthority=$false; taskAuthority=$false
        }
        if ($Context.ContainsKey('HistoryHandoffRestartSettlement')) {
            if ($status -cne 'restart-lock-retirement-directory-retired') {
                throw 'Restart lock settlement survived without its absent directory.'
            }
            $value.status = 'restart-lock-settled'
            $value.settlement = $Context.HistoryHandoffRestartSettlement.Descriptor
        }
        return $value
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock retirement observation failed; retain evidence.', $_.Exception)
    }
}

function Open-AgentsChatStoppedHistoryHandoffRestartRetirementObservation(
    [string]$Control, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, $Prepared, $Committed, $Retirement, $Terminal, $Successor, $Abandoned, $Restart,
    $RestartCommitted, $RestartRetirement, $RestartSettlement
) {
    try {
        if ($null -eq $RestartCommitted -or $null -eq $RestartRetirement) {
            throw 'Restart lock retirement observation descriptors are required.'
        }
        return Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
            $AttemptId $Prepared $Committed $Retirement $Terminal $Successor $Abandoned $Restart $RestartCommitted `
            $null $null $RestartRetirement $RestartSettlement
    } catch {
        throw [InvalidOperationException]::new('Restart lock retirement observation failed; retain evidence.', $_.Exception)
    }
}
