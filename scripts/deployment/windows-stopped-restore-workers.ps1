function Assert-AgentsChatStoppedRestoreWorkerInventory([hashtable]$Context) {
    $Context.Stage = 'worker-inventory'
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $expected.Add('worker-engine')
    $null = $expected.Add('worker-operation.ndjson')
    if ($Context.ContainsKey('ColdRetirementMarker')) {
        $Context.ColdRetirementMarker.Check()
        $null = $expected.Add('worker-retirement.json')
    }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($entry.Name.StartsWith('worker-', [StringComparison]::OrdinalIgnoreCase) -and
            -not $expected.Remove($entry.Name)) { throw 'Foreign stopped restore worker inventory.' }
    }
    if ($expected.Count) { throw 'Original stopped restore worker evidence is missing.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Context.WorkerNames) { $null = $expected.Add($name) }
    foreach ($entry in Get-ChildItem -LiteralPath (Join-Path $Context.Control 'worker-engine') -Force) {
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) { throw 'Foreign stopped restore worker helpers.' }
    }
    if ($expected.Count) { throw 'Original stopped restore worker helpers are missing.' }
}

function Open-AgentsChatStoppedRestoreWorkers([hashtable]$Context) {
    $Context.Stage = 'worker-evidence'
    $operation = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'worker-operation.ndjson') ''
    if ($operation.ByteLength -gt 65536) { throw 'Oversized empty worker operation.' }
    $text = $operation.ReadText()
    if (-not $text.EndsWith("`n", [StringComparison]::Ordinal) -or $text.Contains("`r")) {
        throw 'Original worker operation is not a complete journal.'
    }
    $lines = $text.Substring(0, $text.Length - 1).Split("`n")
    if ($lines.Count -lt 1 -or $lines.Count -gt 2) { throw 'Cold restore refuses enrolled or unsettled workers.' }
    $manifestSha256 = $null
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $record = Read-AgentsChatMaintenanceFields $lines[$index] @('version', 'phase', 'lock', 'manifestSha256', 'workerId')
        if ($record.version.GetInt32() -ne 1 -or
            $record.phase.GetString() -cne $(if ($index -eq 0) { 'opened' } else { 'sealed' }) -or
            $record.workerId.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
            throw 'Original restore worker operation is not empty.'
        }
        $lock = Read-AgentsChatMaintenanceFields $record.lock.GetRawText() ([string[]]@($Context.OriginalLock.Keys))
        Assert-AgentsChatCompletionFields $lock $Context.OriginalLock ([string[]]@($Context.OriginalLock.Keys))
        $digest = $record.manifestSha256.GetString()
        if ($digest -cnotmatch '^[a-f0-9]{64}$' -or ($manifestSha256 -and $digest -cne $manifestSha256)) {
            throw 'Original restore worker engine binding differs.'
        }
        $manifestSha256 = $digest
    }
    $Context.Stage = 'worker-manifest'
    $directory = Join-Path $Context.Control 'worker-engine'
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
    $manifest = Open-AgentsChatCompletionFile $Context (Join-Path $directory 'manifest.json') $manifestSha256
    if ($manifest.ByteLength -gt 32768) { throw 'Oversized restore worker manifest.' }
    $stored = Read-AgentsChatMaintenanceFields ($manifest.ReadText()) @('version', 'project', 'operationId', 'files')
    if ($stored.version.GetInt32() -ne 1 -or $stored.project.GetString() -cne $Context.Project -or
        $stored.operationId.GetString() -cne $Context.OperationId -or
        $stored.files.ValueKind -ne [Text.Json.JsonValueKind]::Array -or
        $stored.files.GetArrayLength() -lt 1 -or $stored.files.GetArrayLength() -gt 256) {
        throw 'Original restore worker manifest identity differs.'
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null = $names.Add('manifest.json')
    $declared = [Collections.Generic.List[object]]::new()
    $total = 0L
    foreach ($value in $stored.files.EnumerateArray()) {
        $fields = Read-AgentsChatMaintenanceFields $value.GetRawText() @('name', 'bytes', 'sha256')
        $name = $fields.name.GetString()
        $bytes = $fields.bytes.GetInt64()
        $sha256 = $fields.sha256.GetString()
        if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or -not $names.Add($name) -or
            $bytes -lt 0 -or $bytes -gt 1048576 -or $sha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Unsupported restore worker helper.'
        }
        $total += $bytes
        if ($total -gt 16777216) { throw 'Restore worker helpers exceed their byte budget.' }
        $declared.Add(@{ name=$name; bytes=$bytes; sha256=$sha256 })
    }
    $Context.WorkerNames = [string[]]@($names)
    Assert-AgentsChatStoppedRestoreWorkerInventory $Context
    $Context.Stage = 'worker-helper'
    foreach ($entry in $declared) {
        $file = Open-AgentsChatCompletionFile $Context (Join-Path $directory $entry.name) $entry.sha256
        if ($file.ByteLength -ne $entry.bytes) { throw 'Original restore worker helper length differs.' }
    }
    Assert-AgentsChatStoppedRestoreWorkerInventory $Context
}
