function New-AgentsChatManagedTaskAdmission {
    param(
        [hashtable]$Context, [string]$Control, [string]$LockSha256, [string]$StateSha256,
        [int]$ControllerPid, [string]$ControllerIdentity
    )
    $files = [Collections.Generic.List[IDisposable]]::new()
    $failure = $null
    try {
        $project = $Context.Project
        if ($Control -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Control) -cne $Control -or
            $Control -match '[\x00\r\n]' -or $Control.Length -gt 4096 -or
            $LockSha256 -cnotmatch '^[a-f0-9]{64}$' -or $StateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [string]::Equals($project, $Control, [StringComparison]::OrdinalIgnoreCase) -or
            $Control.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $project.StartsWith($Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Admission control must be canonical and external to the managed project.'
        }
        $files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
        $files.Add([Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Control 'lock')))
        foreach ($entry in @('recovery-lock', 'task-maintenance', 'task-retirement.json',
            'task-retirement-checkpoint.json', 'worker-retirement.json', 'live-retirement.json',
            'cold-restore-complete.json')) {
            if (Test-Path -LiteralPath (Join-Path $Control $entry)) { throw "Existing admission or recovery evidence: $entry." }
        }
        $lockPath = Join-Path $Control 'lock/owner.json'
        $statePath = Join-Path $Control 'state.json'
        foreach ($file in @($lockPath, $statePath)) {
            if ((Get-Item -LiteralPath $file -Force).Length -gt 65536) { throw 'Oversized admission state.' }
        }
        $owner = [Deployment.WindowsPrivateFile]::Open($lockPath, $LockSha256)
        $files.Add($owner)
        $fields = Read-AgentsChatMaintenanceFields ($owner.ReadText()) @(
            'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
        $operationId = $fields.operationId.GetString()
        Assert-AgentsChatCompletionGuid ($fields.token.GetString())
        Assert-AgentsChatCompletionGuid $operationId
        if ($fields.version.GetInt32() -ne 1 -or $fields.project.GetString() -cne $project -or
            $fields.pid.GetInt32() -ne $ControllerPid -or
            $fields.processIdentity.GetString() -cne $ControllerIdentity -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Admission requires the actual original live Node lock owner.'
        }
        $stateFile = [Deployment.WindowsPrivateFile]::Open($statePath, $StateSha256)
        $files.Add($stateFile)
        $state = ConvertFrom-AgentsChatTaskTransactionState @{
            Project=$project; OperationId=$operationId; Generation=$Context.Runtime.generation
            StartedAt=$fields.createdAt.GetString()
        } ($stateFile.ReadText())
        $phase = if ($state.operation -ceq 'restore') { 'restore-preflight' } else { 'preflight' }
        if ($state.phase -cne $phase -or $null -ne $state.previousPhase) {
            throw 'Admission requires original preflight state.'
        }
        $null = Assert-AgentsChatManagedTask $Context
        foreach ($file in $files) { $file.Check() }
        $record = [ordered]@{
            version=1; operationId=$operationId
            controllerPid=$ControllerPid; controllerIdentity=$ControllerIdentity
            taskName=$Context.TaskName; definition=$Context.NativeDefinition
            securityDescriptor=$Context.SecurityDescriptor
            configuration=$Context.Configuration; configurationSha256=$Context.ConfigurationSha256
            readySha256=$Context.Runtime.readySha256; ownerPid=$Context.Runtime.pid
            ownerIdentity=$Context.Runtime.identity; generation=$Context.Runtime.generation
            instanceGuid=$Context.Runtime.instanceGuid
        }
        $directory = Join-Path $Control 'task-maintenance'
        $files.Add([Deployment.WindowsPrivateFile]::CreateDirectory($directory))
        $path = Join-Path $directory 'admission.json'
        $published = [Deployment.WindowsPrivateFile]::Publish($path, ($record | ConvertTo-Json -Depth 8 -Compress))
        $files.Add($published)
        $null = Assert-AgentsChatManagedTask $Context
        foreach ($file in $files) { $file.Check() }
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity -or
            (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock'))) { throw 'Admission ownership changed.' }
        return [pscustomobject]@{ admission=$path; sha256=$published.Sha256 }
    } catch {
        $failure = $_.Exception
        throw
    } finally {
        $failures = [Collections.Generic.List[Exception]]::new()
        if ($failure) { $failures.Add($failure) }
        for ($index = $files.Count - 1; $index -ge 0; $index--) {
            try { $files[$index].Dispose() }
            catch { $failures.Add($_.Exception) }
        }
        if ($failures.Count -gt $(if ($failure) { 1 } else { 0 })) {
            throw [AggregateException]::new('Admission capture and handle release failed; retain evidence.', $failures)
        }
    }
}
