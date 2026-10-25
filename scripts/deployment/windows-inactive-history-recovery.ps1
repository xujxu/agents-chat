function Initialize-AgentsChatStoppedHistoryRecovery([hashtable]$Context) {
    $path = Join-Path $Context.Control 'inactive-rollback-history-intent.json'
    $original = Open-AgentsChatCompletionFile $Context $path ''
    if ($original.ByteLength -gt 65536) { throw 'Oversized stopped history archive intent.' }
    $record = Read-AgentsChatRetirementJson ($original.ReadText())
    Assert-AgentsChatRetirementFields $record @('version', 'phase', 'control', 'project', 'operationId',
        'stateSha256', 'retiredSha256', 'controlIdentity', 'entries')
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -isnot [string] -or $record.phase -cne 'stopped-history-archive-prepared' -or
        $record.control -isnot [string] -or $record.control -cne $Context.Control -or
        $record.project -isnot [string] -or $record.operationId -isnot [string] -or
        $record.stateSha256 -isnot [string] -or $record.stateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $record.retiredSha256 -isnot [string] -or $record.retiredSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $record.entries -isnot [array] -or $record.entries.Count -notin @(10, 12)) {
        throw 'Invalid stopped history archive scope.'
    }
    Assert-AgentsChatCompletionGuid $record.operationId
    Assert-AgentsChatRetirementIdentity $record.controlIdentity
    $names = Get-AgentsChatStoppedHistoryNames ($record.entries.Count -eq 12)
    $paths = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $active = $false
    for ($index = 0; $index -lt $names.Count; $index++) {
        $entry = $record.entries[$index]
        Assert-AgentsChatRetirementFields $entry @('path', 'destination', 'dev', 'ino', 'bytes', 'sha256')
        Assert-AgentsChatRetirementDescriptor @{
            path=$entry.path; dev=$entry.dev; ino=$entry.ino; bytes=$entry.bytes; sha256=$entry.sha256
        } $names[$index]
        if ($entry.destination -isnot [string] -or
            $entry.destination -cne "retired-$($record.operationId)-$($entry.path)") {
            throw 'Stopped history archive destination differs.'
        }
        $source = Join-Path $Context.Control $entry.path
        $destination = Join-Path $Context.Control $entry.destination
        $sourcePresent = Test-Path -LiteralPath $source
        $archivePresent = Test-Path -LiteralPath $destination
        if ($sourcePresent -eq $archivePresent -or ($archivePresent -and $active)) {
            throw 'Stopped history archive has a missing, duplicate or non-prefix entry.'
        }
        if ($sourcePresent) { $active = $true }
        $paths.Add($source, $(if ($sourcePresent) { $source } else { $destination }))
    }
    $identity = $original.CaptureIdentity()
    $hash = $original.Sha256
    $bytes = $original.ByteLength
    $original.Dispose()
    $null = $Context.Files.Remove($original)
    $Context.HistoryIntent = [Deployment.WindowsPrivateFile]::OpenExclusive(
        $path, $hash, $identity.Dev, $identity.Ino, $bytes)
    $Context.Files.Add($Context.HistoryIntent)
    $Context.HistoryRecord = $record
    $Context.HistoryPaths = $paths
    $Context.HistoryFiles = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
}

function Assert-AgentsChatStoppedHistoryRecovery([hashtable]$Context) {
    $record = $Context.HistoryRecord
    if ($Context.Prefix -ne $Context.Record.entries.Count -or -not $Context.ContainsKey('FinalReceipt') -or
        $record.project -cne $Context.Project -or $record.operationId -cne $Context.OperationId -or
        $record.stateSha256 -cne $Context.TaskRecord.stateSha256 -or
        $record.retiredSha256 -cne $Context.FinalReceipt.Sha256 -or
        $record.controlIdentity.dev -cne $Context.TaskRecord.checkpoint.controlIdentity.dev -or
        $record.controlIdentity.ino -cne $Context.TaskRecord.checkpoint.controlIdentity.ino) {
        throw 'Stopped history archive differs from original final retirement.'
    }
    $names = Get-AgentsChatStoppedHistoryNames ($Context.ContainsKey('RuntimeHandoffReleased'))
    if ($names.Count -ne $record.entries.Count) { throw 'Stopped history archive runtime inventory differs.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $expected.Add('inactive-rollback-history-intent.json')
    foreach ($entry in $record.entries) {
        $source = Join-Path $Context.Control $entry.path
        $destination = Join-Path $Context.Control $entry.destination
        $actual = Resolve-AgentsChatCompletionPath $Context $source
        if ((Test-Path -LiteralPath $source) -eq (Test-Path -LiteralPath $destination) -or
            -not (Test-Path -LiteralPath $actual)) {
            throw 'Stopped history archive namespace changed.'
        }
        $null = $expected.Add([IO.Path]::GetFileName($actual))
        if (-not $Context.HistoryFiles.ContainsKey($entry.path)) {
            $held = if ($entry.path -ceq 'inactive-rollback-workers.json') { $Context.Marker }
                elseif ($entry.path -ceq 'inactive-rollback-retirement.json') { $Context.TaskMarker }
                elseif ($entry.path -ceq 'inactive-rollback-retired.json') { $Context.FinalReceipt }
                else { Open-AgentsChatCompletionFile $Context $source $entry.sha256 }
            $Context.HistoryFiles[$entry.path] = $held
        }
        $held = $Context.HistoryFiles[$entry.path]
        $held.Check()
        $identity = $held.CaptureIdentity()
        if ($identity.Dev -cne $entry.dev -or $identity.Ino -cne $entry.ino -or
            $held.ByteLength -ne $entry.bytes -or $held.Sha256 -cne $entry.sha256) {
            throw 'Stopped history archive original file was replaced.'
        }
    }
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-rollback-*.json' -or
            $item.Name -like "retired-$($Context.OperationId)-inactive-rollback-*.json") {
            if ($item.PSIsContainer -or -not $expected.Remove($item.Name)) {
                throw 'Stopped history archive contains foreign namespace evidence.'
            }
        }
    }
    if ($expected.Count) { throw 'Stopped history archive namespace is incomplete.' }
    $Context.HistoryIntent.Check()
}

function Get-AgentsChatStoppedHistoryProgress([hashtable]$Context) {
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    $prefix = 0
    foreach ($entry in $Context.HistoryRecord.entries) {
        $source = Join-Path $Context.Control $entry.path
        if ($Context.HistoryPaths[$source] -ceq $source) { break }
        $prefix++
    }
    return [ordered]@{
        status=$(if ($prefix -eq $Context.HistoryRecord.entries.Count) { 'archived' } else { 'archiving' })
        operationId=$Context.OperationId; stateSha256=$Context.TaskRecord.stateSha256
        retiredSha256=$Context.FinalReceipt.Sha256
        archivedEntries=$prefix; totalEntries=$Context.HistoryRecord.entries.Count
    }
}

function Move-AgentsChatNextStoppedHistoryEntry([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryWriter') -or -not $Context.HistoryWriter) {
        throw 'Stopped history verification is read-only.'
    }
    $progress = Get-AgentsChatStoppedHistoryProgress $Context
    if ($progress.archivedEntries -eq $progress.totalEntries) { return $progress }
    $entry = $Context.HistoryRecord.entries[$progress.archivedEntries]
    $source = Join-Path $Context.Control $entry.path
    $destination = Join-Path $Context.Control $entry.destination
    try {
        $Context.HistoryFiles[$entry.path].ArchiveTo($destination)
        $Context.HistoryPaths[$source] = $destination
        return Get-AgentsChatStoppedHistoryProgress $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Stopped history archival failed; retain original prepared evidence.', $_.Exception)
    }
}
