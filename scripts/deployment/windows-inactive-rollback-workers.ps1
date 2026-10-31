. (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')
. (Join-Path $PSScriptRoot 'windows-deployment-retirement-evidence.ps1')

function Assert-AgentsChatStoppedWorkerJournals([hashtable]$Context, $Lock, $Workers) {
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'worker-operation.ndjson') ''
    $records = @($file.ReadText().TrimEnd("`n").Split("`n") | ForEach-Object {
        Read-AgentsChatMaintenanceFields $_ @('version', 'phase', 'lock', 'manifestSha256', 'workerId')
    })
    $lockNames = @('version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    $expectedLock = Read-AgentsChatMaintenanceFields ($Lock | ConvertTo-Json -Compress) $lockNames
    foreach ($record in $records) {
        $actualLock = Read-AgentsChatMaintenanceFields $record.lock.GetRawText() $lockNames
        Assert-AgentsChatCompletionFields $actualLock $expectedLock $lockNames
        if ($record.version.GetInt32() -ne 1 -or
            $record.manifestSha256.GetString() -cne $Workers.manifestSha256 -or
            ($record.phase.GetString() -cne 'enrolled' -and
                $record.workerId.ValueKind -ne [Text.Json.JsonValueKind]::Null)) {
            throw 'Stopped worker operation differs from original sealed enrollment.'
        }
    }
    $Context.WorkerDomains = [Collections.Generic.List[object]]::new()
    foreach ($entry in $Workers.entries) {
        if ($entry.path -cnotmatch '^worker-([a-f0-9-]{36})\.ndjson$') { continue }
        $workerId = $Matches[1]
        $journal = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control $entry.path) $entry.sha256
        $rows = @($journal.ReadText().TrimEnd("`n").Split("`n") | ForEach-Object {
            Read-AgentsChatMaintenanceFields $_ @('version', 'owner', 'phase', 'domain')
        })
        if ($rows.Count -lt 2 -or $rows.Count -gt 5 -or
            $rows[0].phase.GetString() -cne 'intent' -or
            $rows[-1].phase.GetString() -cne 'settled') { throw 'Stopped worker journal is not settled.' }
        $previous = ''
        $domainText = $null
        foreach ($row in $rows) {
            $owner = Read-AgentsChatMaintenanceFields $row.owner.GetRawText() @(
                'project', 'operationId', 'workerId', 'controllerIdentity')
            $phase = $row.phase.GetString()
            $allowed = switch -CaseSensitive ($previous) {
                '' { @('intent') }
                'intent' { @('owned', 'settled') }
                'owned' { @('admitted', 'settled') }
                'admitted' { @('settled') }
                default { @() }
            }
            if ($row.version.GetInt32() -ne 1 -or $phase -cnotin $allowed -or
                $owner.project.GetString() -cne $Context.Project -or
                $owner.operationId.GetString() -cne $Context.OperationId -or
                $owner.workerId.GetString() -cne $workerId -or
                $owner.controllerIdentity.GetString() -cne $Lock.processIdentity -or
                ($phase -ceq 'intent' -and $row.domain.ValueKind -ne [Text.Json.JsonValueKind]::Null) -or
                ($phase -cin @('owned', 'admitted') -and $row.domain.ValueKind -eq [Text.Json.JsonValueKind]::Null)) {
                throw 'Stopped worker journal identity or transition differs.'
            }
            if ($row.domain.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
                $domain = Read-AgentsChatMaintenanceFields $row.domain.GetRawText() @(
                    'kind', 'name', 'generation', 'accountSid', 'sessionId', 'ownerIdentity')
                if ($domain.kind.GetString() -cne 'windows-job' -or
                    $domain.name.GetString() -cne "Local\agents-deploy-$workerId" -or
                    $domain.generation.GetString() -cne $workerId -or
                    $domain.accountSid.GetString() -cnotmatch '^S-1-[0-9]+(?:-[0-9]+)+$' -or
                    $domain.sessionId.GetInt32() -lt 0 -or
                    $domain.ownerIdentity.GetString() -cne $Lock.processIdentity -or
                    ($null -ne $domainText -and $row.domain.GetRawText() -cne $domainText)) {
                    throw 'Stopped worker Job identity changed.'
                }
                $domainText = $row.domain.GetRawText()
                [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$workerId, $domain.sessionId.GetInt32())
            } elseif ($null -ne $domainText) { throw 'Stopped worker lost its original Job identity.' }
            $previous = $phase
        }
        if ($null -ne $domainText) {
            $Context.WorkerDomains.Add(@{ generation=$workerId; sessionId=$domain.sessionId.GetInt32() })
        }
    }
}

function Publish-AgentsChatStoppedWorkerRetirement([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveRollbackCleanup $Context
    if ($Context.Prefix -ne $Context.Record.entries.Count) { throw 'Stopped task history is not fully retired.' }
    $path = Join-Path $Context.Control 'inactive-rollback-workers.json'
    if ($Context.ContainsKey('WorkerRetirementIntent')) {
        $Context.WorkerRetirementIntent.Check()
        return [ordered]@{ file=$path; sha256=$Context.WorkerRetirementIntent.Sha256 }
    }
    if (Test-Path -LiteralPath $path) { throw 'Stopped worker retirement requires its independent resumption entry.' }
    $owner = Open-AgentsChatRetirementFile $Context $Context.Record.checkpoint.lock 'lock\owner.json'
    $lock = Read-AgentsChatRetirementJson ($owner.ReadText())
    $workers = Get-AgentsChatCompletedWorkerEvidence $Context $lock
    Assert-AgentsChatStoppedWorkerJournals $Context $lock $workers
    $entries = [Collections.Generic.List[object]]::new()
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context 'task-maintenance'))
    foreach ($entry in $workers.entries) { $entries.Add($entry) }
    $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context 'lock\owner.json'))
    $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context 'lock'))
    $identity = $Context.Marker.CaptureIdentity()
    $candidate = [ordered]@{
        version=1; phase='stopped-worker-retirement-prepared'
        control=$Context.Control; project=$Context.Project; operationId=$Context.OperationId
        priorRuntime='stopped'; restoredRuntime='stopped'
        task=[ordered]@{ path='inactive-rollback-retirement.json'; dev=$identity.Dev; ino=$identity.Ino
            bytes=$Context.Marker.ByteLength; sha256=$Context.Marker.Sha256 }
        lockText=$owner.ReadText(); workerManifestSha256=$workers.manifestSha256
        domains=$Context.WorkerDomains.ToArray(); entries=$entries.ToArray()
    }
    $null = Assert-AgentsChatInactiveRollbackCleanup $Context
    $intent = [Deployment.WindowsPrivateFile]::Publish($path, ($candidate | ConvertTo-Json -Depth 12 -Compress))
    $Context.Files.Add($intent)
    $Context.WorkerRetirementIntent = $intent
    $null = Assert-AgentsChatInactiveRollbackCleanup $Context
    return [ordered]@{ file=$path; sha256=$intent.Sha256 }
}
