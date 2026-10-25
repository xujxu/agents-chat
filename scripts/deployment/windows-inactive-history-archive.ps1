function Assert-AgentsChatStoppedHistoryInventory([hashtable]$Context, [string[]]$Names) {
    $intentName = 'inactive-rollback-history-intent.json'
    $expected = [Collections.Generic.HashSet[string]]::new($Names, [StringComparer]::Ordinal)
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-rollback-*.json') {
            if ($item.PSIsContainer -or
                ($item.Name -cne $intentName -and -not $expected.Remove($item.Name))) {
                throw 'Stopped history archival contains unknown evidence.'
            }
        }
    }
    if ($expected.Count) { throw 'Stopped history archival is missing original evidence.' }
}

function Publish-AgentsChatStoppedHistoryArchiveIntent([hashtable]$Context) {
    $observation = Assert-AgentsChatStoppedWorkerCleanup $Context
    if ($observation.status -cne 'retired' -or $Context.Prefix -ne $Context.Record.entries.Count -or
        -not $Context.ContainsKey('FinalReceipt')) {
        throw 'History archival requires final original stopped worker retirement.'
    }
    $names = [string[]]@(
        'inactive-rollback-intent.json', 'inactive-rollback-files-restored.json',
        'inactive-rollback-task-intent.json', 'inactive-rollback-task-restored.json',
        'inactive-rollback-terminal.json', 'inactive-rollback-state-intent.json',
        'inactive-rollback-complete.json', 'inactive-rollback-retirement.json',
        'inactive-rollback-workers.json', 'inactive-rollback-retired.json'
    )
    if ($Context.ContainsKey('RuntimeHandoffReleased')) {
        $names += @('inactive-rollback-runtime-handoff.json', 'inactive-rollback-runtime-released.json')
    }
    [Array]::Sort($names, [StringComparer]::Ordinal)
    Assert-AgentsChatStoppedHistoryInventory $Context $names
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($name in $names) {
        $held = if ($name -ceq 'inactive-rollback-workers.json') { $Context.Marker }
            elseif ($name -ceq 'inactive-rollback-retirement.json') { $Context.TaskMarker }
            elseif ($name -ceq 'inactive-rollback-retired.json') { $Context.FinalReceipt }
            else { Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control $name) '' }
        $held.Check()
        $identity = $held.CaptureIdentity()
        $destination = "retired-$($Context.OperationId)-$name"
        if (Test-Path -LiteralPath (Join-Path $Context.Control $destination)) {
            throw 'Stopped history archive destination already exists.'
        }
        $entries.Add([ordered]@{
            path=$name; destination=$destination
            dev=$identity.Dev; ino=$identity.Ino; bytes=$held.ByteLength; sha256=$held.Sha256
        })
    }
    $record = [ordered]@{
        version=1; phase='stopped-history-archive-prepared'
        control=$Context.Control; project=$Context.Project; operationId=$Context.OperationId
        stateSha256=$Context.TaskRecord.stateSha256; retiredSha256=$Context.FinalReceipt.Sha256
        controlIdentity=$Context.TaskRecord.checkpoint.controlIdentity; entries=$entries.ToArray()
    }
    $text = $record | ConvertTo-Json -Depth 6 -Compress
    $path = Join-Path $Context.Control 'inactive-rollback-history-intent.json'
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    Assert-AgentsChatStoppedHistoryInventory $Context $names
    if (Test-Path -LiteralPath $path) {
        $intent = Open-AgentsChatCompletionFile $Context $path ''
    } else {
        $intent = [Deployment.WindowsPrivateFile]::Publish($path, $text)
        $Context.Files.Add($intent)
    }
    if ($intent.ReadText() -cne $text) { throw 'Stopped history archive intent differs from original identities.' }
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    Assert-AgentsChatStoppedHistoryInventory $Context $names
    return [ordered]@{ file=$path; sha256=$intent.Sha256 }
}
