. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-state-write.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartReleaseRecord(
    [hashtable]$Context, $Creator, [string]$Time, [switch]$Released
) {
    Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
    $observed = $Context.HistoryHandoffObservedCommit
    $prepared = $Context.HistoryHandoffRestartPrepared
    $request = $prepared.Request
    Assert-AgentsChatRetirementCreator $Creator $observed.ControllerPid $observed.ControllerIdentity
    if ($Creator.pid -ne $observed.ControllerPid -or
        $Creator.processIdentity -cne $observed.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or
        $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Restart release creator differs from its actual owner.'
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
    $state = Open-AgentsChatStoppedHistoryState $Context $record.state
    if ($state.ReadText() -cne $record.oldState) { throw 'Restart release original state differs.' }
    $committed = $Context.HistoryHandoffRestartCommitted
    $lock = $Context.HistoryHandoffRestartLock
    $written = $Context.ContainsKey('HistoryHandoffRestartState')
    if ($written) {
        Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
        $stateIntent = $Context.HistoryHandoffRestartStateIntent
        $writtenState = $Context.HistoryHandoffRestartState
        $text = Get-AgentsChatStoppedHistoryHandoffRestartStateText $Context
        $writtenState.File.Check()
        if ($writtenState.File.ReadText() -cne $text) { throw 'Restart release written state differs from its ninth record.' }
        $descriptor = Get-AgentsChatStoppedHandoffDescriptor $writtenState.File 'state.json'
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($descriptor[$field] -cne $writtenState.Descriptor[$field]) { throw 'Restart release written state differs.' }
        }
        if (-not $Released) { Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $Time $stateIntent.CreatedAt }
    }
    $value = [ordered]@{
        version=1
        phase=$(if ($Released) { 'stopped-history-handoff-restart-released' } else { 'stopped-history-handoff-restart-release-prepared' })
        attemptId=$request.AttemptId; control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId
        prepared=$prepared.Descriptor; committed=$committed.Descriptor; newOwner=$record.newOwner
        lockIdentity=$lock.DirectoryIdentity; lock=$lock.OwnerDescriptor; state=$record.state
    }
    if ($written) {
        $value.stateIntent = $stateIntent.Descriptor
        $value.writtenState = $writtenState.Descriptor
    }
    $value.creator = $Creator
    if ($Released) {
        $intent = $Context.HistoryHandoffRestartRelease
        Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $Time $intent.Time
        if ($lock.ContainsKey('Released') -cne $true -or $lock.Released -ne $true) {
            throw 'Restart release settlement requires its exact released lock.'
        }
        $value.retirement = $intent.Descriptor
        $value.releasedAt = $Time
    } else {
        Assert-AgentsChatStoppedHistoryHandoffLockRetirementTime $Time $committed.CommittedAt
        $value.createdAt = $Time
    }
    $parsed = [DateTimeOffset]::ParseExact($Time, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($parsed -gt [DateTimeOffset]::UtcNow) { throw 'Restart release is in the future.' }
    return $value
}

function Assert-AgentsChatStoppedHistoryHandoffRestartReleaseRecord([hashtable]$Context, [string]$Key, [switch]$Released) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartReleaser') -or
        $Context.HistoryHandoffRestartReleaser -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver') -or
        -not $Context.ContainsKey($Key)) {
        throw 'Restart release lacks retained independent native proof.'
    }
    $retained = $Context[$Key]
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('Time')) {
        throw 'Restart release lacks retained independent native proof.'
    }
    $suffix = if ($Released) { 'lock-retired' } else { 'lock-retirement' }
    $name = "inactive-handoff-$($Context.HistoryHandoffRestartPrepared.Request.AttemptId)-$suffix.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 65536
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Restart release descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context $retained.Creator $retained.Time -Released:$Released
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

function Assert-AgentsChatStoppedHistoryHandoffRestartRelease([hashtable]$Context) {
    Assert-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context 'HistoryHandoffRestartRelease'
}

function Assert-AgentsChatStoppedHistoryHandoffRestartReleased([hashtable]$Context) {
    Assert-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context 'HistoryHandoffRestartReleased' -Released
}

function Publish-AgentsChatStoppedHistoryHandoffRestartReleaseRecord(
    [hashtable]$Context, $Creator, [string]$Key, [switch]$Released
) {
    $time = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    $record = Get-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context $Creator $time -Released:$Released
    $text = $record | ConvertTo-Json -Depth 8 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Restart release record is oversized.' }
    $suffix = if ($Released) { 'lock-retired' } else { 'lock-retirement' }
    $name = "inactive-handoff-$($record.attemptId)-$suffix.json"
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
    $Context.Files.Add($file)
    $Context[$Key] = @{
        File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name); Creator=$Creator; Time=$time
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context $Key -Released:$Released
    return $Context[$Key].Descriptor
}

function Remove-AgentsChatStoppedHistoryHandoffRestartLock(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartReleaser') -or
        $Context.HistoryHandoffRestartReleaser -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart release requires its independent native role.'
    }
    try {
        if ($Context.Poisoned) { throw 'Restart release scope is poisoned.' }
        if ($Context.ContainsKey('HistoryHandoffRestartRelease') -or $Context.ContainsKey('HistoryHandoffRestartReleased')) {
            throw 'Restart release already retained.'
        }
        $written = $Context.ContainsKey('HistoryHandoffRestartState')
        if ($written) {
            # Only the live writer that acknowledged its exact ninth-record write may release after it.
            if (-not $Context.ContainsKey('HistoryHandoffRestartStateWriter') -or
                $Context.HistoryHandoffRestartStateWriter -ne $true -or
                -not $Context.ContainsKey('HistoryHandoffRestartStateIntent') -or
                $Context.ContainsKey('HistoryHandoffRestartStateStage') -or
                $Context.ContainsKey('HistoryHandoffRestartStateObserver')) {
                throw 'Restart release follows an unacknowledged state transition.'
            }
        } else {
            foreach ($key in @('HistoryHandoffRestartStateIntent', 'HistoryHandoffRestartStateIntender',
                'HistoryHandoffRestartStateWriter', 'HistoryHandoffRestartStateStage')) {
                if ($Context.ContainsKey($key)) { throw 'Restart release follows a state transition.' }
            }
        }
        if (-not $Context.ContainsKey('HistoryHandoffRestartCommitter') -or $Context.HistoryHandoffRestartCommitter -ne $true) {
            throw 'Restart release requires its exact committed owner.'
        }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart release controller differs.'
        }
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock*').Length) {
            throw 'Restart release found a state stage.'
        }
        if ($written -and -not $Context.ContainsKey('HistoryStateTransition')) {
            # The acknowledged write replaced the original state inode; original-state readers must resolve it through the ninth record.
            Initialize-AgentsChatStoppedHistoryStateTransition $Context ([ordered]@{
                restart=$Context.HistoryHandoffRestartPrepared.Descriptor
                restartCommitted=$Context.HistoryHandoffRestartCommitted.Descriptor
                restartStateIntent=$Context.HistoryHandoffRestartStateIntent.Descriptor
                restartState=$Context.HistoryHandoffRestartState.Descriptor
            })
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartCommitted $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $retirement = Publish-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context $creator 'HistoryHandoffRestartRelease'
        $lock = $Context.HistoryHandoffRestartLock
        $owner = $lock.OwnerDescriptor
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $old = $lock.OwnerFile
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.OwnerFile = $null
        $target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
            (Join-Path $Context.Control 'lock\owner.json'), $owner.sha256, $owner.dev, $owner.ino, $owner.bytes)
        $Context.Files.Add($target)
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Restart release owner identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $old = $lock.Directory
        $old.Dispose()
        $null = $Context.Files.Remove($old)
        $lock.Directory = $null
        $target = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement(
            (Join-Path $Context.Control 'lock'), $lock.DirectoryIdentity.dev, $lock.DirectoryIdentity.ino)
        $Context.Files.Add($target)
        $target.Check()
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Restart release owner identity differs.'
        }
        $target.Delete()
        $null = $Context.Files.Remove($target)
        $lock.Released = $true
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $released = Publish-AgentsChatStoppedHistoryHandoffRestartReleaseRecord $Context $creator `
            'HistoryHandoffRestartReleased' -Released
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartReleased $Context
        $request = $Context.HistoryHandoffRestartPrepared.Request
        $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
        $result = [ordered]@{
            status='restart-released'; attemptId=$request.AttemptId
            prepared=$Context.HistoryHandoffRestartPrepared.Descriptor
            committed=$Context.HistoryHandoffRestartCommitted.Descriptor
            retirement=$retirement; released=$released; state=$record.state
        }
        if ($written) {
            $result.stateIntent = $Context.HistoryHandoffRestartStateIntent.Descriptor
            $result.writtenState = $Context.HistoryHandoffRestartState.Descriptor
        }
        $result.runtimeAuthority = $false
        $result.lockAuthority = $false
        $result.taskAuthority = $false
        return $result
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart release failed; retain evidence.', $_.Exception)
    }
}
