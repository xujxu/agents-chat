function Get-AgentsChatDeploymentRetirementFile([hashtable]$Context, [string]$Relative) {
    $descriptor = Get-AgentsChatRetirementFile $Context $Relative
    $entry = [ordered]@{ kind='file' }
    foreach ($name in $descriptor.Keys) { $entry[$name] = $descriptor[$name] }
    return $entry
}

function Get-AgentsChatDeploymentRetirementDirectory([hashtable]$Context, [string]$Relative) {
    $identity = Get-AgentsChatRetirementDirectory $Context (Join-Path $Context.Control $Relative)
    return [ordered]@{ kind='directory'; path=$Relative; dev=$identity.dev; ino=$identity.ino }
}

function Assert-AgentsChatDeploymentWorkerInventory([hashtable]$Context, $Entries) {
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $Entries) { $null = $expected.Add($entry.path) }
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name.StartsWith('worker-', [StringComparison]::OrdinalIgnoreCase)) {
            if (-not $expected.Remove($item.Name)) { throw 'Foreign worker cleanup inventory.' }
        }
    }
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Context.Control 'worker-engine') -Force) {
        if ($item.PSIsContainer -or -not $expected.Remove("worker-engine\$($item.Name)")) {
            throw 'Foreign saved worker helper inventory.'
        }
    }
    if ($expected.Count) { throw 'Missing original worker cleanup evidence.' }
}

function Get-AgentsChatCompletedWorkerEvidence([hashtable]$Context, $Lock) {
    $Context.Stage = 'worker-evidence'
    $operation = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'worker-operation.ndjson') ''
    $records = @($operation.ReadText().TrimEnd("`n").Split("`n") | ForEach-Object {
        Read-AgentsChatMaintenanceFields $_ @('version', 'phase', 'lock', 'manifestSha256', 'workerId')
    })
    if ($records.Count -lt 2 -or $records.Count -gt 34 -or
        $records[0].phase.GetString() -cne 'opened' -or $records[-1].phase.GetString() -cne 'sealed') {
        throw 'Original worker operation is not sealed.'
    }
    $entries = [Collections.Generic.List[object]]::new()
    $workers = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = 1; $index -lt $records.Count - 1; $index++) {
        $worker = $records[$index].workerId.GetString()
        Assert-AgentsChatCompletionGuid $worker
        if ($records[$index].phase.GetString() -cne 'enrolled' -or -not $workers.Add($worker)) {
            throw 'Invalid worker cleanup enrollment.'
        }
        $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context "worker-$worker.ndjson"))
    }
    $engineIdentity = Get-AgentsChatDeploymentRetirementDirectory $Context 'worker-engine'
    $manifest = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'worker-engine\manifest.json') ''
    $stored = Read-AgentsChatRetirementJson ($manifest.ReadText())
    Assert-AgentsChatRetirementFields $stored @('version', 'project', 'operationId', 'files')
    if ($stored.version -ne 1 -or $stored.project -cne $Context.Project -or
        $stored.operationId -cne $Lock.operationId -or
        $manifest.Sha256 -cne $records[0].manifestSha256.GetString() -or
        $stored.files -isnot [array] -or $stored.files.Count -lt 1 -or $stored.files.Count -gt 256) {
        throw 'Original worker helper manifest differs.'
    }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $null = $names.Add('manifest.json')
    foreach ($file in $stored.files) {
        Assert-AgentsChatRetirementFields $file @('name', 'bytes', 'sha256')
        if ($file.name -isnot [string] -or $file.name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
            -not $names.Add($file.name)) { throw 'Invalid worker helper name.' }
        $entry = Get-AgentsChatDeploymentRetirementFile $Context "worker-engine\$($file.name)"
        if ($entry.bytes -ne $file.bytes -or $entry.sha256 -cne $file.sha256) { throw 'Original worker helper changed.' }
        $entries.Add($entry)
    }
    $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context 'worker-engine\manifest.json'))
    $entries.Add($engineIdentity)
    $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context 'worker-operation.ndjson'))
    Assert-AgentsChatDeploymentWorkerInventory $Context $entries.ToArray()
    return [ordered]@{ entries=$entries.ToArray(); manifestSha256=$manifest.Sha256 }
}

function Retain-AgentsChatDeploymentWorkers([hashtable]$Context) {
    $null = Assert-AgentsChatTaskRetirement $Context
    if ($Context.Prefix -ne $Context.Intent.files.Count) { throw 'Task receipts have not finished retiring.' }
    if ($Context.ContainsKey('DeploymentCandidate')) { return $Context.DeploymentCandidate }
    $entries = [Collections.Generic.List[object]]::new()
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context 'task-maintenance'))
    $workers = Get-AgentsChatCompletedWorkerEvidence $Context $Context.Intent.lock
    foreach ($entry in $workers.entries) { $entries.Add($entry) }
    foreach ($relative in @('task-retirement.json', 'task-retirement-checkpoint.json', 'lock\owner.json')) {
        $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context $relative))
    }
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context 'lock'))
    $Context.DeploymentCandidate = [ordered]@{
        version=3; control=$Context.Control; task=$Context.Prepared
        workerManifestSha256=$workers.manifestSha256; entries=$entries.ToArray()
        creator=[ordered]@{ pid=$Context.ControllerPid; processIdentity=$Context.ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID) }
    }
    $null = Assert-AgentsChatTaskRetirement $Context
    return $Context.DeploymentCandidate
}

function Publish-AgentsChatDeploymentRetirement([hashtable]$Context) {
    if (-not $Context.ContainsKey('DeploymentCandidate')) { throw 'Worker evidence has not been retained.' }
    $null = Assert-AgentsChatTaskRetirement $Context
    $candidate = $Context.DeploymentCandidate
    Assert-AgentsChatDeploymentWorkerInventory $Context @($candidate.entries | Where-Object {
        $_.path.StartsWith('worker-', [StringComparison]::Ordinal)
    })
    $marker = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control 'worker-retirement.json'),
        ($candidate | ConvertTo-Json -Depth 16 -Compress))
    $Context.Files.Add($marker)
    $null = Assert-AgentsChatTaskRetirement $Context
}
