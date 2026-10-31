function Test-AgentsChatStoppedHistoryHandoffRestartRelease(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, [switch]$Continue,
    [switch]$StateWritten, [switch]$IntentOnly
) {
    if ($IntentOnly -and -not $Continue) { throw 'Held restart release intent requires a hold.' }
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-release.ps1')
    $ownerPath = Join-Path $Context.Control 'lock\owner.json'
    $lock = $Context.HistoryHandoffRestartLock
    $ownerText = $lock.OwnerFile.ReadText()
    foreach ($command in @('Remove-AgentsChatStoppedHistoryHandoffRestartLock',
        'Publish-AgentsChatStoppedHistoryHandoffRestartReleaseIntent')) {
        $refused = $false
        try { $null = & $command $Context $ControllerPid $ControllerIdentity }
        catch {
            if ($_.Exception.Message -cne 'Restart release requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused -or $Context.Poisoned -or $lock.OwnerFile.ReadText() -cne $ownerText) {
            throw 'Restart lock released without its independent role.'
        }
    }
    $attempt = $Context.HistoryHandoffRestartPrepared.Request.AttemptId
    foreach ($name in @("inactive-handoff-$attempt-lock-retirement.json", "inactive-handoff-$attempt-lock-retired.json")) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) { throw 'Refused restart release published a record.' }
    }
    $committed = $Context.HistoryHandoffRestartCommitted
    $committedText = $committed.File.ReadText()
    if ($StateWritten -ne $Context.ContainsKey('HistoryHandoffRestartState')) {
        throw 'Restart release state-write precondition differs.'
    }
    if ($StateWritten) {
        $stateIntent = $Context.HistoryHandoffRestartStateIntent
        $writtenState = $Context.HistoryHandoffRestartState
        $intentText = $stateIntent.File.ReadText()
        $writtenText = $writtenState.File.ReadText()
    }
    $preparedText = $Context.HistoryHandoffRestartPrepared.File.ReadText()
    $stateHash = (Get-FileHash -LiteralPath (Join-Path $Context.Control 'state.json') -Algorithm SHA256).Hash
    $directory = $lock.DirectoryIdentity
    $owner = $lock.OwnerDescriptor
    $Context.HistoryHandoffRestartReleaser = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
    if ($IntentOnly) {
        $result = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity release-intent
        if ($result.status -cne 'restart-release-prepared' -or $result.attemptId -cne $attempt -or
            $result.retirement.path -cne "inactive-handoff-$attempt-lock-retirement.json" -or
            $result.Contains('released') -or $result.Contains('stateIntent') -ne [bool]$StateWritten -or
            $result.Contains('writtenState') -ne [bool]$StateWritten -or
            $result.runtimeAuthority -ne $false -or $result.lockAuthority -ne $false -or $result.taskAuthority -ne $false) {
            throw 'Restart release intent result differs.'
        }
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($result.committed[$field] -cne $committed.Descriptor[$field] -or
                $result.lock[$field] -cne $owner[$field]) { throw 'Restart release intent binding differs.' }
            if ($StateWritten -and ($result.stateIntent[$field] -cne $stateIntent.Descriptor[$field] -or
                $result.writtenState[$field] -cne $writtenState.Descriptor[$field] -or
                $stateIntent.File.ReadText() -cne $intentText -or $writtenState.File.ReadText() -cne $writtenText)) {
                throw 'Post-write restart release intent state binding differs.'
            }
        }
        # The live releaser holds its exact tenth record before deleting any part of the committed lock.
        if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf) -or $lock.OwnerFile.ReadText() -cne $ownerText -or
            (Test-Path -LiteralPath (Join-Path $Context.Control "inactive-handoff-$attempt-lock-retired.json")) -or
            $lock.DirectoryIdentity -ne $directory -or $committed.File.ReadText() -cne $committedText -or
            $Context.HistoryHandoffRestartPrepared.File.ReadText() -cne $preparedText -or
            (Get-FileHash -LiteralPath (Join-Path $Context.Control 'state.json') -Algorithm SHA256).Hash -cne $stateHash -or
            [IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock*').Length) {
            throw 'Restart release intent changed its lock retained evidence or original state.'
        }
        return $result
    }
    $result = Invoke-AgentsChatRestartPublicationProofFrames $Context $ControllerPid $ControllerIdentity release
    if ($result.status -cne 'restart-released' -or $result.attemptId -cne $attempt -or
        $result.retirement.path -cne "inactive-handoff-$attempt-lock-retirement.json" -or
        $result.released.path -cne "inactive-handoff-$attempt-lock-retired.json" -or
        $result.runtimeAuthority -ne $false -or $result.lockAuthority -ne $false -or $result.taskAuthority -ne $false) {
        throw 'Restart release result differs.'
    }
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($result.committed[$field] -cne $committed.Descriptor[$field]) { throw 'Restart release committed binding differs.' }
    }
    if ($StateWritten) {
        if (-not $result.Contains('stateIntent') -or -not $result.Contains('writtenState')) {
            throw 'Post-write restart release omitted its state binding.'
        }
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($result.stateIntent[$field] -cne $stateIntent.Descriptor[$field] -or
                $result.writtenState[$field] -cne $writtenState.Descriptor[$field]) {
                throw 'Post-write restart release state binding differs.'
            }
        }
        foreach ($name in @($result.retirement.path, $result.released.path)) {
            $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $Context.Control $name)))
            try {
                $root = $document.RootElement
                foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
                    if ($root.GetProperty('stateIntent').GetProperty($field).ToString() -cne [string]$stateIntent.Descriptor[$field] -or
                        $root.GetProperty('writtenState').GetProperty($field).ToString() -cne [string]$writtenState.Descriptor[$field]) {
                        throw 'Post-write restart release record state binding differs.'
                    }
                }
            } finally { $document.Dispose() }
        }
        if ($stateIntent.File.ReadText() -cne $intentText -or $writtenState.File.ReadText() -cne $writtenText) {
            throw 'Post-write restart release changed its ninth record or written state.'
        }
    } elseif ($result.Contains('stateIntent') -or $result.Contains('writtenState')) {
        throw 'Pre-write restart release reported a state binding.'
    }
    if ((Test-Path -LiteralPath $ownerPath) -or (Test-Path -LiteralPath (Join-Path $Context.Control 'lock'))) {
        throw 'Restart release retained its lock.'
    }
    if ($lock.DirectoryIdentity -ne $directory -or $lock.OwnerDescriptor -ne $owner -or
        $committed.File.ReadText() -cne $committedText -or
        $Context.HistoryHandoffRestartPrepared.File.ReadText() -cne $preparedText -or
        (Get-FileHash -LiteralPath (Join-Path $Context.Control 'state.json') -Algorithm SHA256).Hash -cne $stateHash -or
        [IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock*').Length) {
        throw 'Restart release changed its retained evidence or original state.'
    }
    if ($Continue) { return $result }
    $retirementText = [IO.File]::ReadAllText((Join-Path $Context.Control $result.retirement.path))
    $releasedText = [IO.File]::ReadAllText((Join-Path $Context.Control $result.released.path))
    $refused = $false
    try { $null = Remove-AgentsChatStoppedHistoryHandoffRestartLock $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart release failed; retain evidence.') { throw }
        $refused = $true
    }
    if (-not $refused -or -not $Context.Poisoned -or (Test-Path -LiteralPath (Join-Path $Context.Control 'lock')) -or
        [IO.File]::ReadAllText((Join-Path $Context.Control $result.retirement.path)) -cne $retirementText -or
        [IO.File]::ReadAllText((Join-Path $Context.Control $result.released.path)) -cne $releasedText) {
        throw 'Duplicate restart release failed to preserve and poison.'
    }
    return $result
}
