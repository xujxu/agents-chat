function Assert-AgentsChatDeploymentEntry($Entry) {
    if ($Entry.kind -ceq 'directory') {
        Assert-AgentsChatRetirementFields $Entry @('kind', 'path', 'dev', 'ino')
        Assert-AgentsChatRetirementIdentity @{ dev=$Entry.dev; ino=$Entry.ino }
        if ($Entry.path -cnotin @('task-maintenance', 'worker-engine', 'lock')) {
            throw 'Unexpected retirement directory.'
        }
    } elseif ($Entry.kind -ceq 'file') {
        Assert-AgentsChatRetirementFields $Entry @('kind', 'path', 'dev', 'ino', 'bytes', 'sha256')
        $descriptor = [ordered]@{}
        foreach ($name in @('path', 'dev', 'ino', 'bytes', 'sha256')) { $descriptor[$name] = $Entry[$name] }
        Assert-AgentsChatRetirementDescriptor $descriptor $Entry.path
        if ($Entry.path -cnotmatch '^worker-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.ndjson$' -and
            $Entry.path -cnotmatch '^worker-engine\\[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -and
            $Entry.path -cnotin @('worker-operation.ndjson', 'task-retirement.json',
                'task-retirement-checkpoint.json', 'lock\owner.json')) {
            throw 'Unexpected retirement file.'
        }
    } else { throw 'Unexpected retirement entry kind.' }
}

function Assert-AgentsChatDeploymentPlan([hashtable]$Context, $Record) {
    Assert-AgentsChatRetirementFields $Record @('version', 'control', 'task', 'workerManifestSha256', 'entries', 'creator')
    if ($Record.version -isnot [int] -or $Record.version -ne 3 -or $Record.control -cne $Context.Control -or
        $Record.workerManifestSha256 -isnot [string] -or $Record.workerManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Record.entries -isnot [array] -or $Record.entries.Count -lt 9 -or $Record.entries.Count -gt 296) {
        throw 'Invalid deployment retirement manifest.'
    }
    Assert-AgentsChatRetirementCreator $Record.creator $Context.ControllerPid $Context.ControllerIdentity
    Initialize-AgentsChatRetirementRecords $Context $Record.task
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Record.entries) {
        Assert-AgentsChatDeploymentEntry $entry
        if (-not $names.Add($entry.path)) { throw 'Duplicate deployment retirement entry.' }
    }
    $entries = $Record.entries
    $index = 1
    $workerCount = 0
    while ($index -lt $entries.Count -and
        $entries[$index].path -cmatch '^worker-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.ndjson$') {
        if ($entries[$index].kind -cne 'file' -or ++$workerCount -gt 32) { throw 'Invalid worker cleanup order.' }
        $index++
    }
    $helpers = 0
    while ($index -lt $entries.Count -and $entries[$index].path.StartsWith('worker-engine\', [StringComparison]::Ordinal)) {
        if ($entries[$index].kind -cne 'file') { throw 'Invalid helper cleanup kind.' }
        $index++
        $helpers++
    }
    $tail = @('worker-engine', 'worker-operation.ndjson', 'task-retirement.json',
        'task-retirement-checkpoint.json', 'lock\owner.json', 'lock')
    if ($helpers -lt 2 -or $helpers -gt 257 -or $entries.Count - $index -ne $tail.Count -or
        $entries[0].kind -cne 'directory' -or $entries[0].path -cne 'task-maintenance' -or
        $entries[$index - 1].path -cne 'worker-engine\manifest.json' -or
        $entries[$index - 1].sha256 -cne $Record.workerManifestSha256) {
        throw 'Invalid deployment retirement order.'
    }
    for ($offset = 0; $offset -lt $tail.Count; $offset++) {
        $entry = $entries[$index + $offset]
        $kind = if ($offset -eq 0 -or $offset -eq 5) { 'directory' } else { 'file' }
        if ($entry.path -cne $tail[$offset] -or $entry.kind -cne $kind) { throw 'Invalid deployment retirement suffix.' }
    }
    foreach ($pair in @(
        @($entries[0], $Context.Intent.maintenanceIdentity),
        @($entries[-1], $Context.Intent.lockIdentity),
        @($entries[-2], $Context.Intent.lockFile),
        @($entries[-3], $Record.task.descriptor),
        @($entries[-4], $Record.task.intent.descriptor)
    )) {
        foreach ($name in $pair[1].Keys) {
            if ($pair[0][$name] -cne $pair[1][$name]) { throw 'Original task retirement identity differs.' }
        }
    }
}

function Assert-AgentsChatDeploymentInventory([hashtable]$Context) {
    $Context.Stage = 'deployment-inventory'
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Record.entries.Count; $index++) {
        $null = $expected.Add($Context.Record.entries[$index].path)
    }
    $null = $expected.Add('worker-retirement.json')
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -match '^(worker-|task-retirement|service-)' -or
            $item.Name -in @('task-maintenance', 'lock', 'recovery-lock')) {
            if (-not $expected.Remove($item.Name)) { throw 'Unexpected deployment retirement inventory.' }
        }
    }
    foreach ($directory in @('task-maintenance', 'worker-engine', 'lock')) {
        $children = @($expected | Where-Object { $_.StartsWith("$directory\", [StringComparison]::Ordinal) })
        $present = Test-Path -LiteralPath (Join-Path $Context.Control $directory)
        if ($Context.Target -and $Context.Target.Entry.kind -ceq 'directory' -and
            $Context.Target.Entry.path -ceq $directory) {
            if ($children.Count -or -not $present) { throw 'Exclusive directory target is not the next empty entry.' }
            $Context.Target.Handle.Check()
        } elseif ($present) {
            foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Context.Control $directory) -Force) {
                if ($item.PSIsContainer -or -not $expected.Remove("$directory\$($item.Name)")) {
                    throw 'Unexpected nested deployment retirement inventory.'
                }
            }
        }
    }
    if ($expected.Count) { throw 'Remaining deployment retirement evidence disappeared.' }
}

function Assert-AgentsChatDeploymentRetirement([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Deployment retirement is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatDeploymentInventory $Context
        Assert-AgentsChatRetirementControllers $Context
        Assert-AgentsChatRetirementCreator $Context.Record.creator $Context.ControllerPid $Context.ControllerIdentity
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatDeploymentInventory $Context
        Assert-AgentsChatRetirementControllers $Context
        Assert-AgentsChatCompletionFinalRuntime $Context
        return [ordered]@{ status='retiring-deployment'; retiredEntries=$Context.Prefix; manifest=$Context.Manifest }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Deployment retirement refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatDeploymentRetirement {
    param([string]$Control, [int]$ControllerPid, [string]$ControllerIdentity)
    $context = @{
        Control=$Control; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null
        Stage='deployment-manifest'; Prefix=0; Target=$null
    }
    try {
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
        $marker = Open-AgentsChatCompletionFile $context (Join-Path $Control 'worker-retirement.json') ''
        $record = Read-AgentsChatRetirementJson ($marker.ReadText())
        Assert-AgentsChatDeploymentPlan $context $record
        $context.Record = $record
        $context.Marker = $marker
        $identity = $marker.CaptureIdentity()
        $context.Manifest = [ordered]@{ record=$record; descriptor=[ordered]@{
            path='worker-retirement.json'; dev=$identity.Dev; ino=$identity.Ino
            bytes=$marker.ByteLength; sha256=$marker.Sha256
        } }
        $context.Stage = 'deployment-prefix'
        $context.Entries = [object[]]::new($record.entries.Count)
        $remainingStarted = $false
        for ($index = 0; $index -lt $record.entries.Count; $index++) {
            $entry = $record.entries[$index]
            $file = Join-Path $Control $entry.path
            if (-not (Test-Path -LiteralPath $file)) {
                if ($remainingStarted) { throw 'Non-prefix deployment retirement inventory.' }
                $context.Prefix++
                continue
            }
            $remainingStarted = $true
            if ($entry.kind -ceq 'directory') {
                $retained = [Deployment.WindowsPrivateFile]::OpenDirectory($file)
                $context.Files.Add($retained)
            } else { $retained = Open-AgentsChatCompletionFile $context $file $entry.sha256 }
            $context.Entries[$index] = $retained
            $identity = $retained.CaptureIdentity()
            if ($identity.Dev -cne $entry.dev -or $identity.Ino -cne $entry.ino -or
                ($entry.kind -ceq 'file' -and $retained.ByteLength -ne $entry.bytes)) {
                throw 'Original deployment retirement entry was replaced.'
            }
        }
        Open-AgentsChatRetirementRuntime $context
        $null = Assert-AgentsChatDeploymentRetirement $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Deployment retirement open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Deployment retirement open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Remove-AgentsChatNextDeploymentEntry([hashtable]$Context) {
    $null = Assert-AgentsChatDeploymentRetirement $Context
    $target = $null
    try {
        $index = $Context.Prefix
        $commit = $index -eq $Context.Record.entries.Count
        $entry = if ($commit) { $Context.Manifest.descriptor } else { $Context.Record.entries[$index] }
        $original = if ($commit) { $Context.Marker } else { $Context.Entries[$index] }
        $original.Check()
        $original.Dispose()
        $null = $Context.Files.Remove($original)
        $file = Join-Path $Context.Control $entry.path
        if (-not $commit -and $entry.kind -ceq 'directory') {
            $target = [Deployment.WindowsPrivateFile]::RetainDirectoryForRetirement($file, $entry.dev, $entry.ino)
        } else {
            $target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
                $file, $entry.sha256, $entry.dev, $entry.ino, $entry.bytes)
        }
        if (-not $commit) { $Context.Target = @{ Entry=$entry; Handle=$target } }
        $null = Assert-AgentsChatDeploymentRetirement $Context
        $target.Check()
        $target.Delete()
        $target = $null
        $Context.Target = $null
        if ($commit) {
            $result = [ordered]@{ status='retired'; retiredEntries=$index; manifest=$Context.Manifest }
            Close-AgentsChatTaskCompletionProof $Context
            return $result
        }
        $Context.Entries[$index] = $null
        $Context.Prefix++
        return Assert-AgentsChatDeploymentRetirement $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally {
        $Context.Target = $null
        if ($target) { $target.Dispose() }
    }
}
