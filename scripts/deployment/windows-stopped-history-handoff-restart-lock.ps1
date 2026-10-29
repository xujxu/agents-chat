. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-publication.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRestartLock([hashtable]$Context) {
    $publisher = $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -and
        $Context.HistoryHandoffRestartLockPublisher -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        -not $Context.ContainsKey('HistoryHandoffRestartLockObserver')
    $observer = $Context.ContainsKey('HistoryHandoffRestartLockObserver') -and
        $Context.HistoryHandoffRestartLockObserver -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -and
        -not $Context.ContainsKey('HistoryHandoffRestartOwnerPublisher')
    if ($publisher -eq $observer -or -not $Context.ContainsKey('HistoryHandoffRestartLock')) {
        throw 'Restart lock lacks retained independent native publication proof.'
    }
    # An observer binds its lock before the restart prepared record is initialized; the owner
    # binding below is enforced on every later assertion once that record is retained.
    $bound = $publisher -or $Context.ContainsKey('HistoryHandoffRestartPrepared')
    if ($bound) { Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context }
    $lock = $Context.HistoryHandoffRestartLock
    $lock.Directory.Check()
    $identity = $lock.Directory.CaptureIdentity()
    if ($identity.Dev -cne $lock.DirectoryIdentity.dev -or
        $identity.Ino -cne $lock.DirectoryIdentity.ino) {
        throw 'Restart lock directory identity differs.'
    }
    $root = @(Get-ChildItem -LiteralPath $Context.Control -Force |
        Where-Object { $_.Name -ieq 'lock' })
    if ($root.Count -ne 1 -or $root[0].Name -cne 'lock' -or -not $root[0].PSIsContainer) {
        throw 'Restart lock directory inventory differs.'
    }
    $children = @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force)
    if ($lock.ContainsKey('OwnerFile') -or $lock.ContainsKey('OwnerDescriptor')) {
        if ((-not $observer -and (-not $Context.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
            $Context.HistoryHandoffRestartOwnerPublisher -ne $true)) -or
            -not $lock.ContainsKey('OwnerFile') -or -not $lock.ContainsKey('OwnerDescriptor') -or
            $null -eq $lock.OwnerFile -or $null -eq $lock.OwnerDescriptor -or
            $children.Count -ne 1 -or $children[0].PSIsContainer -or $children[0].Name -cne 'owner.json') {
            throw 'Restart lock owner lacks retained independent native publication proof.'
        }
        $lock.OwnerFile.Check()
        if ($bound) {
            $request = $Context.HistoryHandoffRestartPrepared.Request
            $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
            if ($lock.OwnerFile.ReadText() -cne ($record.newOwner | ConvertTo-Json -Compress)) {
                throw 'Restart lock owner bytes differ.'
            }
        }
        Assert-AgentsChatRetirementDescriptor $lock.OwnerDescriptor 'lock\owner.json' 65536
        $descriptor = Get-AgentsChatStoppedHandoffDescriptor $lock.OwnerFile 'lock\owner.json'
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($descriptor[$field] -cne $lock.OwnerDescriptor[$field]) {
                throw 'Restart lock owner descriptor differs.'
            }
        }
        $lock.OwnerFile.Check()
    } elseif ($observer -or $children.Count) {
        throw 'Restart lock directory inventory differs.'
    }
    $lock.Directory.Check()
}

function New-AgentsChatStoppedHistoryHandoffRestartLockDirectory(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -or
        $Context.HistoryHandoffRestartLockPublisher -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart lock publication requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffRestartLock')) { throw 'Restart lock already retained.' }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart lock controller differs.'
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
        $request = $Context.HistoryHandoffRestartPrepared.Request
        $created = [DateTimeOffset]::ParseExact($request.CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($created -gt [DateTimeOffset]::UtcNow) { throw 'Restart lock publication predates preparation.' }
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $directory = [Deployment.WindowsPrivateFile]::CreateDirectory((Join-Path $Context.Control 'lock'))
        $Context.Files.Add($directory)
        $identity = $directory.CaptureIdentity()
        $Context.HistoryHandoffRestartLock = @{
            Directory=$directory; DirectoryIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
        }
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartLock $Context
        return $Context.HistoryHandoffRestartLock.DirectoryIdentity
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart lock publication failed; retain evidence.', $_.Exception)
    }
}
