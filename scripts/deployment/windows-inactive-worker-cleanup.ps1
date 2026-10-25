. (Join-Path $PSScriptRoot 'windows-inactive-rollback-cleanup.ps1')
. (Join-Path $PSScriptRoot 'windows-deployment-retirement.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-history-archive.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-history-recovery.ps1')

function Assert-AgentsChatStoppedWorkerPlan([hashtable]$Context, $Record) {
    Assert-AgentsChatRetirementFields $Record @('version', 'phase', 'control', 'project', 'operationId',
        'priorRuntime', 'restoredRuntime', 'task', 'lockText', 'workerManifestSha256', 'domains', 'entries')
    if ($Record.version -isnot [int] -or $Record.version -ne 1 -or
        $Record.phase -cne 'stopped-worker-retirement-prepared' -or $Record.control -cne $Context.Control -or
        $Record.project -cne $Context.Project -or $Record.operationId -cne $Context.OperationId -or
        $Record.priorRuntime -cne 'stopped' -or $Record.restoredRuntime -cne 'stopped' -or
        $Record.workerManifestSha256 -isnot [string] -or $Record.workerManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Record.entries -isnot [array] -or $Record.entries.Count -lt 7 -or $Record.entries.Count -gt 294 -or
        $Record.domains -isnot [array]) { throw 'Invalid stopped worker cleanup checkpoint.' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Record.entries) {
        Assert-AgentsChatDeploymentEntry $entry
        if (-not $names.Add($entry.path)) { throw 'Duplicate stopped worker cleanup entry.' }
    }
    $entries = $Record.entries
    $index = 1
    $workers = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    while ($index -lt $entries.Count -and $entries[$index].path -cmatch '^worker-([a-f0-9-]{36})\.ndjson$') {
        $workerId = $Matches[1]
        Assert-AgentsChatCompletionGuid $workerId
        if (-not $workers.Add($workerId) -or $workers.Count -gt 32 -or $entries[$index].kind -cne 'file') {
            throw 'Invalid stopped worker journal order.'
        }
        $index++
    }
    $helpers = 0
    while ($index -lt $entries.Count -and $entries[$index].path.StartsWith('worker-engine\', [StringComparison]::Ordinal)) {
        if ($entries[$index].kind -cne 'file') { throw 'Invalid stopped helper cleanup kind.' }
        $helpers++
        $index++
    }
    $suffix = @('worker-engine', 'worker-operation.ndjson', 'lock\owner.json', 'lock')
    if ($helpers -lt 2 -or $helpers -gt 257 -or $entries.Count - $index -ne $suffix.Count -or
        $entries[0].kind -cne 'directory' -or $entries[0].path -cne 'task-maintenance' -or
        $entries[$index - 1].path -cne 'worker-engine\manifest.json' -or
        $entries[$index - 1].sha256 -cne $Record.workerManifestSha256) {
        throw 'Invalid stopped worker retirement order.'
    }
    for ($offset = 0; $offset -lt $suffix.Count; $offset++) {
        $kind = if ($offset -in @(0, 3)) { 'directory' } else { 'file' }
        if ($entries[$index + $offset].path -cne $suffix[$offset] -or $entries[$index + $offset].kind -cne $kind) {
            throw 'Invalid stopped worker cleanup suffix.'
        }
    }
    foreach ($pair in @(
        @($entries[0], $Context.TaskRecord.directory),
        @($entries[-2], $Context.TaskRecord.checkpoint.lock),
        @($entries[-1], $Context.TaskRecord.checkpoint.lockIdentity)
    )) {
        foreach ($name in $pair[1].Keys) {
            if ($pair[0][$name] -cne $pair[1][$name]) { throw 'Stopped worker cleanup original authority differs.' }
        }
    }
    $domains = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($domain in $Record.domains) {
        Assert-AgentsChatRetirementFields $domain @('generation', 'sessionId')
        if ($domain.generation -isnot [string] -or -not $workers.Contains($domain.generation) -or
            -not $domains.Add($domain.generation) -or $domain.sessionId -isnot [int] -or $domain.sessionId -lt 0) {
            throw 'Invalid stopped worker cleanup Job.'
        }
    }
}

function Assert-AgentsChatStoppedWorkerInventory([hashtable]$Context) {
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Record.entries.Count; $index++) {
        $null = $expected.Add($Context.Record.entries[$index].path)
    }
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -match '^(worker-|task-retirement|service-)' -or
            $item.Name -in @('task-maintenance', 'lock', 'recovery-lock', 'state.json.lock') -or
            $item.Name -like 'state.json.lock.pending-*') {
            if (-not $expected.Remove($item.Name)) { throw 'Unexpected stopped worker retirement inventory.' }
        }
    }
    foreach ($directory in @('task-maintenance', 'worker-engine', 'lock')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Context.Control $directory))) { continue }
        if ($Context.Target -and $Context.Target.Entry.kind -ceq 'directory' -and $Context.Target.Entry.path -ceq $directory) {
            $Context.Target.Handle.Check()
            continue
        }
        foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Context.Control $directory) -Force) {
            if ($item.PSIsContainer -or -not $expected.Remove("$directory\$($item.Name)")) {
                throw 'Unexpected stopped worker retirement child.'
            }
        }
    }
    if ($expected.Count) { throw 'Stopped worker retirement is not its exact remaining prefix.' }
}

function Get-AgentsChatStoppedWorkerCompletionText([hashtable]$Context) {
    return ([ordered]@{
        version=1; phase='stopped-rollback-retired'; control=$Context.Control; project=$Context.Project
        operationId=$Context.OperationId; priorRuntime='stopped'; restoredRuntime='stopped'
        stateSha256=$Context.TaskRecord.stateSha256; completionSha256=$Context.TaskRecord.completionSha256
        taskRetirementSha256=$Context.TaskMarker.Sha256; workerRetirementSha256=$Context.Marker.Sha256
        retiredEntries=$Context.Record.entries.Count
    } | ConvertTo-Json -Compress)
}

function Get-AgentsChatStoppedWorkerObservation([hashtable]$Context) {
    return [ordered]@{
        status=$(if ($Context.ContainsKey('FinalReceipt')) { 'retired' } else { 'retiring-workers' })
        operationId=$Context.OperationId; stateSha256=$Context.TaskRecord.stateSha256
        completionSha256=$Context.TaskRecord.completionSha256
        retiredEntries=$Context.Prefix; totalEntries=$Context.Record.entries.Count
    }
}

function Assert-AgentsChatStoppedWorkerCleanup([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Stopped worker cleanup is unavailable.' }
    $Context.Busy = $true
    try {
        foreach ($pass in @(1, 2)) {
            foreach ($file in $Context.Files) { $file.Check() }
            if ($Context.Target) { $Context.Target.Handle.Check() }
            Assert-AgentsChatStoppedWorkerInventory $Context
            Assert-AgentsChatStoppedRollbackRuntime $Context
            if (-not $Context.ContainsKey('FinalReceipt') -and
                (Test-Path -LiteralPath (Join-Path $Context.Control 'inactive-rollback-retired.json'))) {
                throw 'Unexpected stopped rollback final retirement publication.'
            }
            if ($Context.ContainsKey('FinalReceipt') -and
                ($Context.Prefix -ne $Context.Record.entries.Count -or
                    $Context.FinalReceipt.ReadText() -cne (Get-AgentsChatStoppedWorkerCompletionText $Context))) {
                throw 'Stopped rollback final retirement receipt differs.'
            }
            if ($Context.ContainsKey('HistoryRecord')) { Assert-AgentsChatStoppedHistoryRecovery $Context }
        }
        return Get-AgentsChatStoppedWorkerObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Stopped worker cleanup evidence changed.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatStoppedWorkerCleanup([string]$Control, [switch]$HistoryArchive) {
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Folder=$null; Instance=$null
        Prefix=0; Target=$null; WorkerMode=$true
    }
    try {
        if ($Control -cnotmatch '^[A-Za-z]:\\' -or $Control.Length -gt 4096 -or
            $Control -match '[\x00\r\n]' -or [IO.Path]::GetFullPath($Control) -cne $Control) {
            throw 'Stopped worker cleanup requires canonical Windows control.'
        }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
        if ($HistoryArchive) { Initialize-AgentsChatStoppedHistoryRecovery $context }
        $markerPath = Resolve-AgentsChatCompletionPath $context (Join-Path $Control 'inactive-rollback-workers.json')
        $original = Open-AgentsChatCompletionFile $context $markerPath ''
        if ($original.ByteLength -gt 1048576) { throw 'Oversized stopped worker checkpoint.' }
        $record = Read-AgentsChatRetirementJson ($original.ReadText())
        $identity = $original.CaptureIdentity()
        $hash = $original.Sha256
        $bytes = $original.ByteLength
        $original.Dispose()
        $null = $context.Files.Remove($original)
        $context.Marker = [Deployment.WindowsPrivateFile]::OpenExclusive($markerPath, $hash, $identity.Dev, $identity.Ino, $bytes)
        $context.Files.Add($context.Marker)
        $task = Open-AgentsChatRetirementFile $context $record.task 'inactive-rollback-retirement.json'
        $taskIdentity = $task.CaptureIdentity()
        $context.Record = Read-AgentsChatRetirementJson ($task.ReadText())
        $task.Dispose()
        $null = $context.Files.Remove($task)
        $context.TaskMarker = [Deployment.WindowsPrivateFile]::OpenExclusive(
            (Resolve-AgentsChatCompletionPath $context (Join-Path $Control 'inactive-rollback-retirement.json')), $record.task.sha256,
            $taskIdentity.Dev, $taskIdentity.Ino, $record.task.bytes)
        $context.Files.Add($context.TaskMarker)
        $context.StoredLockText = $record.lockText
        Initialize-AgentsChatInactiveRollbackCleanup $context
        $context.TaskRecord = $context.Record
        Assert-AgentsChatStoppedWorkerPlan $context $record
        $context.Record = $record
        $context.WorkerDomains = $record.domains
        $context.Entries = [object[]]::new($record.entries.Count)
        $remaining = $false
        for ($index = 0; $index -lt $record.entries.Count; $index++) {
            $entry = $record.entries[$index]
            $file = Join-Path $Control $entry.path
            if (-not (Test-Path -LiteralPath $file)) {
                if ($remaining) { throw 'Non-prefix stopped worker cleanup history.' }
                $context.Prefix++
                continue
            }
            $remaining = $true
            if ($entry.kind -ceq 'directory') {
                $held = [Deployment.WindowsPrivateFile]::OpenDirectory($file)
                $context.Files.Add($held)
            } else { $held = Open-AgentsChatCompletionFile $context $file $entry.sha256 }
            $actual = $held.CaptureIdentity()
            if ($actual.Dev -cne $entry.dev -or $actual.Ino -cne $entry.ino -or
                ($entry.kind -ceq 'file' -and $held.ByteLength -ne $entry.bytes)) {
                throw 'Stopped worker cleanup evidence was replaced.'
            }
            $context.Entries[$index] = $held
        }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $receiptPath = Resolve-AgentsChatCompletionPath $context (Join-Path $Control 'inactive-rollback-retired.json')
        if (Test-Path -LiteralPath $receiptPath) {
            $context.FinalReceipt = Open-AgentsChatCompletionFile $context $receiptPath ''
        }
        $null = Assert-AgentsChatStoppedWorkerCleanup $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Stopped worker cleanup open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Remove-AgentsChatNextStoppedWorkerEntry([hashtable]$Context) {
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    if ($Context.Prefix -eq $Context.Record.entries.Count) {
        if (-not $Context.ContainsKey('FinalReceipt')) {
            $Context.FinalReceipt = [Deployment.WindowsPrivateFile]::Publish(
                (Join-Path $Context.Control 'inactive-rollback-retired.json'),
                (Get-AgentsChatStoppedWorkerCompletionText $Context))
            $Context.Files.Add($Context.FinalReceipt)
        }
        return Assert-AgentsChatStoppedWorkerCleanup $Context
    }
    return Remove-AgentsChatRetirementEntry $Context $null `
        { param($scope) Assert-AgentsChatStoppedWorkerCleanup $scope } `
        { throw 'Stopped worker cleanup must retain its durable checkpoint.' }
}
