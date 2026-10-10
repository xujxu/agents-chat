function Get-AgentsChatFirstActivationTask([hashtable]$Context) {
    $activation = $Context.Activation
    $task = $activation.Task.Folder.GetTask($Context.TaskName)
    $expected = [xml]$activation.Task.Observation.definition
    if ($activation.Enabled) {
        $namespaces = [Xml.XmlNamespaceManager]::new($expected.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $expected.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText = 'true'
    }
    if ([bool]$task.Enabled -ne $activation.Enabled -or
        [string]$task.GetSecurityDescriptor(7) -cne $activation.Task.Observation.securityDescriptor) {
        throw 'Original first-activation task policy changed.'
    }
    Confirm-AgentsChatFirstTaskXml $expected.DocumentElement ([xml][string]$task.Xml).DocumentElement
    return $task
}

function Assert-AgentsChatFirstRuntime([hashtable]$Context) {
    $activation = $Context.Activation
    $task = Get-AgentsChatFirstActivationTask $Context
    if ($null -eq $activation.Runtime) { return }
    $runtime = $activation.Runtime
    if ($activation.Owner.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity) {
        throw 'Original first-runtime owner exited or changed.'
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName -OwnerPid $runtime.pid `
        -OwnerIdentity $runtime.identity -Definition ([string]$task.Xml) `
        -SecurityDescriptor $activation.Task.Observation.securityDescriptor
    if ($binding.instanceGuid -cne $runtime.instanceGuid -or $binding.enabled -or
        $binding.principalSid -cne $activation.Task.Observation.accountSid -or $binding.sessionId -ne $runtime.sessionId) {
        throw 'First-runtime task owner binding differs.'
    }
    $domain = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
    if ($domain.phase -cne 'admitted' -or $domain.quiescent -or
        $domain.members -notcontains $runtime.launcherPid -or $domain.applicationHealthy -or
        [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'guarded') {
        throw 'First runtime lacks its original admitted Job and guarded lease.'
    }
}

function Open-AgentsChatFirstRuntimeListener([hashtable]$Context, [scriptblock]$CheckAuthority) {
    if ($null -eq $Context.Activation -or $null -eq $Context.Activation.Runtime -or $Context.Activation.Stopped) {
        throw 'First-runtime listener requires original active authority.'
    }
    & $CheckAuthority
    $runtime = $Context.Activation.Runtime
    if ($null -eq $Context.Listener) {
        try {
            $Context.Listener = [Deployment.WindowsRuntimeListener]::Retain(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $Context.Port)
        } catch {
            if ($_.Exception.GetBaseException() -isnot [Deployment.WindowsRuntimeListenerNotReadyException]) { throw }
            & $CheckAuthority
            return @{ status='not-ready' }
        }
        $null = Retain-AgentsChatFirstTaskResource $Context $Context.Listener
    }
    & $CheckAuthority
    return [ordered]@{
        status='retained'; generation=$runtime.generation; port=$Context.Port
        pid=$Context.Listener.ListenerPid; identity=$Context.Listener.ListenerIdentity
        address=$Context.Listener.Address; createdAt=$Context.Listener.CreatedAt; pairedRecords=$Context.Listener.PairedRecords
    }
}

function Stop-AgentsChatFirstRuntime([hashtable]$Context) {
    $activation = $Context.Activation
    if ($null -eq $activation -or $activation.Stopped) { return }
    $task = Get-AgentsChatFirstActivationTask $Context
    if ($activation.Enabled) {
        $task.Enabled = $false
        $activation.Enabled = $false
        $task = Get-AgentsChatFirstActivationTask $Context
    }
    if ($null -ne $activation.Runtime -and -not $activation.Owner.HasExited) {
        $runtime = $activation.Runtime
        $stopped = [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'stop', 15000) | ConvertFrom-Json
        if (-not $stopped.quiescent -or $stopped.phase -cne 'stopped' -or $stopped.members.Count -ne 0) {
            throw 'Original first-runtime Job did not settle.'
        }
        if ([Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'retire', 15000) -cne 'retired' -or
            -not $activation.Owner.WaitForExit(15000) -or $activation.Owner.ExitCode -ne 0) {
            throw 'Original first-runtime owner did not retire.'
        }
    } elseif ($null -ne $activation.Instance) {
        $activation.Instance.Refresh()
        if (([guid]$activation.Instance.InstanceGuid).ToString('D') -cne $activation.InstanceGuid) {
            throw 'First-runtime cleanup instance changed.'
        }
        $activation.Instance.Stop()
        if ($null -ne $activation.Owner -and -not $activation.Owner.WaitForExit(15000)) {
            throw 'Original first-runtime owner did not stop.'
        }
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-AgentsChatFirstActivationTask $Context).GetInstances(0).Count -ne 0) {
        if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Original first-runtime instance did not settle.' }
        Start-Sleep -Milliseconds 100
    }
    $receipt = [ordered]@{
        status='first-runtime-stopped'; applicationHealthy=$false; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity; runtime=$activation.Runtime
    }
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Control "first-task-$($Context.OperationId)/activation-stopped.json"),
        ($receipt | ConvertTo-Json -Depth 5 -Compress)))
    $activation.Stopped = $true
}

function Start-AgentsChatFirstRuntime([hashtable]$Context, [hashtable]$Task, [scriptblock]$CheckAuthority) {
    if ($null -ne $Context.Activation -or -not $Context.ActivationPrepared -or
        $null -eq $Context.ActivatingStateSha256 -or $null -eq $Task) {
        throw 'Original first runtime requires its activating successor and unused task.'
    }
    & $CheckAuthority
    $state = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Open(
        (Join-Path $Context.Control 'state.json'), $Context.ActivatingStateSha256))
    $activation = @{
        Task=$Task; Enabled=$false; Instance=$null; InstanceGuid=$null; Owner=$null; Runtime=$null; Stopped=$false
    }
    $Context.Activation = $activation
    $directory = Join-Path $Context.Control "first-task-$($Context.OperationId)"
    $intent = [ordered]@{
        version=1; operationId=$Context.OperationId; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity; stateSha256=$state.Sha256
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        definition=$Task.Observation.definition; securityDescriptor=$Task.Observation.securityDescriptor
    }
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'activation-start-requested.json'), ($intent | ConvertTo-Json -Depth 4 -Compress)))
    & $CheckAuthority
    $Task.File.Check()
    $Task.File.Dispose()
    $null = $Context.Checks.Remove($Task.File)
    $null = $Context.Resources.Remove($Task.File)
    $taskObject = Get-AgentsChatFirstActivationTask $Context
    if ($taskObject.GetInstances(0).Count -ne 0) { throw 'First task started before its original activation request.' }
    $taskObject.Enabled = $true
    $activation.Enabled = $true
    & $CheckAuthority
    $taskObject = Get-AgentsChatFirstActivationTask $Context
    if ($taskObject.GetInstances(0).Count -ne 0) { throw 'Unexpected first-task instance before demand-start.' }
    $activation.Instance = $taskObject.Run($null)
    if ($null -eq $activation.Instance) { throw 'First-task demand-start returned no instance.' }
    $activation.InstanceGuid = ([guid]$activation.Instance.InstanceGuid).ToString('D')
    if ([guid]$activation.InstanceGuid -eq [guid]::Empty) { throw 'First-task instance identity is missing.' }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        & $CheckAuthority
        $activation.Instance.Refresh()
        if ($activation.Instance.Path -cne "\$($Context.TaskName)" -or
            ([guid]$activation.Instance.InstanceGuid).ToString('D') -cne $activation.InstanceGuid -or
            $deadline.ElapsedMilliseconds -ge 15000) { throw 'Original first-task instance did not start.' }
        if ([int]$activation.Instance.EnginePID -lt 1 -or [int]$activation.Instance.State -ne 4) { Start-Sleep -Milliseconds 100 }
    } while ([int]$activation.Instance.EnginePID -lt 1 -or [int]$activation.Instance.State -ne 4)
    $activation.Owner = [Diagnostics.Process]::GetProcessById([int]$activation.Instance.EnginePID)
    $Context.Resources.Add($activation.Owner)
    $null = $activation.Owner.Handle
    $ownerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($activation.Owner.Id)
    $taskObject = Get-AgentsChatFirstActivationTask $Context
    $taskObject.Enabled = $false
    $activation.Enabled = $false
    $null = Get-AgentsChatFirstActivationTask $Context
    $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($Context.TaskName)"
    $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash))
    $readyFile = Join-Path $Context.Bundle.Directory "runtime-$($ownerIdentity.Replace(':', '-')).json"
    $deadline.Restart()
    while (-not (Test-Path -LiteralPath $readyFile)) {
        & $CheckAuthority
        if ($activation.Owner.HasExited -or $deadline.ElapsedMilliseconds -ge 30000) { throw 'First runtime did not publish readiness.' }
        Start-Sleep -Milliseconds 100
    }
    $readyHash = (Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $ready = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Open($readyFile, $readyHash))
    $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
        'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
    $generation = $fields.generation.GetString()
    if ($fields.version.GetInt32() -ne 1 -or $fields.pid.GetInt32() -ne $activation.Owner.Id -or
        $fields.identity.GetString() -cne $ownerIdentity -or $fields.configurationSha256.GetString() -cne $Context.Bundle.Sha256 -or
        [guid]$generation -eq [guid]::Empty -or ([guid]$generation).ToString('D') -cne $generation -or
        $fields.sessionId.GetInt32() -ne $activation.Owner.SessionId -or
        $fields.job.GetString() -cne "Local\agents-deploy-$generation" -or $fields.launcherPid.GetInt32() -lt 1) {
        throw 'First-runtime readiness differs from its original task owner.'
    }
    $activation.Runtime = [ordered]@{
        pid=$activation.Owner.Id; identity=$ownerIdentity; generation=$generation
        instanceGuid=$activation.InstanceGuid; sessionId=$activation.Owner.SessionId
        configurationSha256=$Context.Bundle.Sha256; launcherPid=$fields.launcherPid.GetInt32(); readySha256=$readyHash
    }
    & $CheckAuthority
    $result = [ordered]@{
        status='first-runtime-running'; applicationHealthy=$false; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity
        configurationSha256=$Context.Bundle.Sha256; runtime=$activation.Runtime
    }
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'activation-running.json'), ($result | ConvertTo-Json -Depth 5 -Compress)))
    & $CheckAuthority
    return $result
}
