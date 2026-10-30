. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-commit.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-state-intent.ps1')

function Get-AgentsChatStoppedHistoryHandoffStateIntentRecord([hashtable]$Context, $Creator, [string]$CreatedAt) {
    $commit = $Context.HistoryHandoffCommit
    $request = $commit.Request
    Assert-AgentsChatRetirementCreator $Creator $request.ControllerPid $request.ControllerIdentity
    if ($Creator.pid -ne $request.ControllerPid -or
        $Creator.processIdentity -cne $request.ControllerIdentity -or
        $Creator.bridgePid -ne $PID -or
        $Creator.bridgeIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
        throw 'Handoff state intent creator differs from its actual publisher.'
    }
    $record = Read-AgentsChatRetirementJson ($commit.Prepared.ReadText()) -AllowNull
    Assert-AgentsChatRetirementFields $record @(
        'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
        'previousOperationId', 'operation', 'oldState', 'state', 'intent',
        'completion', 'newOwner', 'observation'
    )
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'stopped-history-handoff-prepared' -or
        $record.attemptId -cne $commit.AttemptId) {
        throw 'Handoff state intent prepared template differs.'
    }
    $lock = $Context.HistoryHandoffLock
    return Get-AgentsChatStoppedHistoryHandoffStateIntentBody $Context @{
        Label='Handoff state intent'; Phase='stopped-history-handoff-state-intent'
        AttemptId=$commit.AttemptId
        Prepared=(Get-AgentsChatStoppedHandoffDescriptor $commit.Prepared $commit.PreparedName 1048576)
        Committed=$commit.Committed; CommittedAt=$commit.CommittedAt
        LockIdentity=$lock.DirectoryIdentity; Lock=$lock.OwnerDescriptor; Record=$record
    } $Creator $CreatedAt
}

function Assert-AgentsChatStoppedHistoryHandoffCommittedRetained([hashtable]$Context, [string[]]$Names) {
    $commit = $Context.HistoryHandoffCommit
    foreach ($pass in (Get-AgentsChatVerificationPasses)) {
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context $Names
        $commit.CommittedFile.Check()
        $actual = Get-AgentsChatStoppedHandoffDescriptor $commit.CommittedFile $commit.CommittedName
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($actual[$field] -cne $commit.Committed[$field]) { throw 'Committed handoff descriptor differs.' }
        }
        Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $commit.AttemptId $commit.Request $commit.Prepared
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context $Names
    }
}

function Assert-AgentsChatStoppedHistoryHandoffStateIntent([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffStateIntent')) {
        throw 'Handoff state intent lacks retained native proof.'
    }
    $retained = $Context.HistoryHandoffStateIntent
    if ($retained -isnot [hashtable] -or -not $retained.ContainsKey('File') -or
        $retained.File -isnot [Deployment.WindowsPrivateFile] -or
        -not $Context.Files.Contains($retained.File) -or
        -not $retained.ContainsKey('Descriptor') -or -not $retained.ContainsKey('Creator') -or
        -not $retained.ContainsKey('CreatedAt')) {
        throw 'Handoff state intent lacks retained native proof.'
    }
    $commit = $Context.HistoryHandoffCommit
    $name = "inactive-handoff-$($commit.AttemptId)-state-intent.json"
    Assert-AgentsChatRetirementDescriptor $retained.Descriptor $name 1048576
    $retained.File.Check()
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Handoff state intent descriptor differs.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffStateIntentRecord $Context $retained.Creator $retained.CreatedAt
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 12 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
    $retained.File.Check()
}

function Publish-AgentsChatStoppedHistoryHandoffStateIntent(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffLockPublisher') -or
        $Context.HistoryHandoffLockPublisher -ne $true) {
        throw 'Handoff state intent requires its independent native role.'
    }
    try {
        if ($Context.Poisoned) { throw 'Handoff state intent scope is poisoned.' }
        if ($Context.ContainsKey('HistoryHandoffStateIntent')) { throw 'Handoff state intent already retained.' }
        if (-not $Context.ContainsKey('HistoryHandoffCommit') -or -not $Context.ContainsKey('HistoryHandoffLock') -or
            -not $Context.HistoryHandoffCommit.ContainsKey('CommittedFile') -or
            $null -eq $Context.HistoryHandoffCommit.Committed) {
            throw 'Handoff state intent requires its committed handoff.'
        }
        $commit = $Context.HistoryHandoffCommit
        if ($ControllerPid -ne $commit.Request.ControllerPid -or
            $ControllerIdentity -cne $commit.Request.ControllerIdentity) {
            throw 'Handoff state intent controller differs.'
        }
        $names = @($commit.PreparedName, $commit.CommittedName)
        Assert-AgentsChatStoppedHistoryHandoffCommittedRetained $Context $names
        $creator = [ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
        $createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $record = Get-AgentsChatStoppedHistoryHandoffStateIntentRecord $Context $creator $createdAt
        $text = $record | ConvertTo-Json -Depth 12 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 1048576) { throw 'Handoff state intent is oversized.' }
        $name = "inactive-handoff-$($commit.AttemptId)-state-intent.json"
        $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
        $Context.Files.Add($file)
        $Context.HistoryHandoffStateIntent = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name 1048576)
            Creator=$creator; CreatedAt=$createdAt
        }
        Assert-AgentsChatStoppedHistoryHandoffStateIntent $Context
        Assert-AgentsChatStoppedHistoryHandoffCommittedRetained $Context @($names + $name)
        Assert-AgentsChatStoppedHistoryHandoffStateIntent $Context
        return $Context.HistoryHandoffStateIntent.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Handoff state intent failed; retain evidence.', $_.Exception)
    }
}
