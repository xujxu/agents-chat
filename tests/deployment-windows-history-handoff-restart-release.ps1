function Test-AgentsChatStoppedHistoryHandoffRestartRelease(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-release.ps1')
    $ownerPath = Join-Path $Context.Control 'lock\owner.json'
    $lock = $Context.HistoryHandoffRestartLock
    $ownerText = $lock.OwnerFile.ReadText()
    $refused = $false
    try { $null = Remove-AgentsChatStoppedHistoryHandoffRestartLock $Context $ControllerPid $ControllerIdentity }
    catch {
        if ($_.Exception.Message -cne 'Restart release requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused -or $Context.Poisoned -or $lock.OwnerFile.ReadText() -cne $ownerText) {
        throw 'Restart lock released without its independent role.'
    }
    $attempt = $Context.HistoryHandoffRestartPrepared.Request.AttemptId
    foreach ($name in @("inactive-handoff-$attempt-lock-retirement.json", "inactive-handoff-$attempt-lock-retired.json")) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) { throw 'Refused restart release published a record.' }
    }
    $committed = $Context.HistoryHandoffRestartCommitted
    $committedText = $committed.File.ReadText()
    $preparedText = $Context.HistoryHandoffRestartPrepared.File.ReadText()
    $stateHash = (Get-FileHash -LiteralPath (Join-Path $Context.Control 'state.json') -Algorithm SHA256).Hash
    $directory = $lock.DirectoryIdentity
    $owner = $lock.OwnerDescriptor
    $Context.HistoryHandoffRestartReleaser = $true
    . (Join-Path $PSScriptRoot 'deployment-windows-restart-publication-progress.ps1')
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
