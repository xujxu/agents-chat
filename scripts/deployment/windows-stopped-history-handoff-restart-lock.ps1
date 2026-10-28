. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-publication.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRestartLock([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartLockPublisher') -or
        $Context.HistoryHandoffRestartLockPublisher -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver') -or
        -not $Context.ContainsKey('HistoryHandoffRestartLock')) {
        throw 'Restart lock lacks retained independent native publication proof.'
    }
    Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
    $lock = $Context.HistoryHandoffRestartLock
    $lock.Directory.Check()
    $identity = $lock.Directory.CaptureIdentity()
    if ($identity.Dev -cne $lock.DirectoryIdentity.dev -or
        $identity.Ino -cne $lock.DirectoryIdentity.ino) {
        throw 'Restart lock directory identity differs.'
    }
    $root = @(Get-ChildItem -LiteralPath $Context.Control -Force |
        Where-Object { $_.Name -ieq 'lock' })
    if ($root.Count -ne 1 -or $root[0].Name -cne 'lock' -or -not $root[0].PSIsContainer -or
        @(Get-ChildItem -LiteralPath (Join-Path $Context.Control 'lock') -Force).Count) {
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
