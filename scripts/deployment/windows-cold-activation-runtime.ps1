function Assert-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    $null = Assert-AgentsChatColdActivationContext $Context
    $runtime = $Context.Runtime
    if (-not $runtime -or $Context.Stopped -or $Context.Owner.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity) {
        throw 'Original cold activated runtime exited or changed.'
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName -OwnerPid $runtime.pid `
        -OwnerIdentity $runtime.identity -Definition $Context.Definition -SecurityDescriptor $Context.SecurityDescriptor
    if ($binding.enabled -or $binding.instanceGuid -cne $runtime.instanceGuid -or
        $binding.sessionId -ne $runtime.sessionId) { throw 'Original cold activated Scheduler instance changed.' }
    $domain = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
    if ($domain.phase -cne 'admitted' -or $domain.quiescent -or $domain.applicationHealthy -or
        $domain.members -notcontains $runtime.launcherPid -or
        [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'guarded') {
        throw 'Cold activated runtime lacks its original guarded Job.'
    }
    $null = Assert-AgentsChatColdActivationContext $Context
    return [ordered]@{
        status='guarded-running'; taskName=$Context.TaskName; runtime=$runtime
        controllerPid=$PID; controllerIdentity=$Context.Identity; configuration=$Context.Configuration
        definition=$Context.Definition; securityDescriptor=$Context.SecurityDescriptor
    }
}

function Start-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    if ($Context.Attempted) { throw 'Cold activation was already attempted.' }
    $Context.Attempted = $true
    Prepare-AgentsChatColdActivationTask $Context
    $Context.Stage = 'enable'
    $task = Assert-AgentsChatColdActivationContext $Context
    $disabled = $Context.Definition
    $task.Enabled = $true
    $task = $Context.Proof.Folder.GetTask($Context.TaskName)
    Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $disabled
    $Context.Definition = [string]$task.Xml
    $Context.Enabled = $true
    $task = Assert-AgentsChatColdActivationContext $Context
    if ($task.GetInstances(0).Count -ne 0) { throw 'Unexpected instance before cold demand-start.' }
    $Context.Stage = 'run'
    $Context.Instance = $task.Run($null)
    if (-not $Context.Instance) { throw 'Cold demand-start returned no native instance.' }
    $Context.InstanceGuid = ([guid]$Context.Instance.InstanceGuid).ToString('D')
    if ([guid]$Context.InstanceGuid -eq [guid]::Empty -or
        $Context.InstanceGuid -ceq $Context.Proof.Admission.instanceGuid.GetString()) {
        throw 'Cold activation reused an original task instance.'
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        $null = Assert-AgentsChatColdActivationContext $Context
        $Context.Instance.Refresh()
        if ($Context.Instance.Path -cne "\$($Context.TaskName)" -or
            ([guid]$Context.Instance.InstanceGuid).ToString('D') -cne $Context.InstanceGuid -or
            $deadline.ElapsedMilliseconds -ge 15000) { throw 'Cold activated instance did not start.' }
        if ([int]$Context.Instance.EnginePID -lt 1 -or [int]$Context.Instance.State -ne 4) { Start-Sleep -Milliseconds 100 }
    } while ([int]$Context.Instance.EnginePID -lt 1 -or [int]$Context.Instance.State -ne 4)
    $Context.Owner = [Diagnostics.Process]::GetProcessById([int]$Context.Instance.EnginePID)
    $null = $Context.Owner.Handle
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id)
    if ($identity -ceq $Context.Proof.Admission.ownerIdentity.GetString()) { throw 'Cold activation reused its original owner.' }
    $Context.Stage = 'inhibit'
    $task = Assert-AgentsChatColdActivationContext $Context
    $task.Enabled = $false
    $Context.Enabled = $false
    $Context.Definition = $disabled
    $null = Assert-AgentsChatColdActivationContext $Context
    $Context.Stage = 'readiness'
    $readyPath = Join-Path $Context.Bundle "runtime-$($identity.Replace(':', '-')).json"
    $deadline.Restart()
    while (-not (Test-Path -LiteralPath $readyPath)) {
        $null = Assert-AgentsChatColdActivationContext $Context
        if ($Context.Owner.HasExited -or $deadline.ElapsedMilliseconds -ge 30000) {
            throw 'Cold activated runtime did not publish readiness.'
        }
        Start-Sleep -Milliseconds 100
    }
    $hash = (Get-FileHash -LiteralPath $readyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ready = Open-AgentsChatCompletionFile $Context.Proof $readyPath $hash
    $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
        'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
    $generation = $fields.generation.GetString()
    if ($fields.version.GetInt32() -ne 1 -or $fields.pid.GetInt32() -ne $Context.Owner.Id -or
        $fields.identity.GetString() -cne $identity -or $fields.configurationSha256.GetString() -cne $Context.ConfigurationSha256 -or
        [guid]$generation -eq [guid]::Empty -or ([guid]$generation).ToString('D') -cne $generation -or
        $generation -ceq $Context.Proof.Admission.generation.GetString() -or
        $fields.sessionId.GetInt32() -ne $Context.Owner.SessionId -or
        $fields.job.GetString() -cne "Local\agents-deploy-$generation" -or $fields.launcherPid.GetInt32() -lt 1) {
        throw 'Cold activated readiness differs from its original task owner.'
    }
    $Context.Runtime = [ordered]@{
        pid=$Context.Owner.Id; identity=$identity; generation=$generation; instanceGuid=$Context.InstanceGuid
        sessionId=$Context.Owner.SessionId; configurationSha256=$Context.ConfigurationSha256
        launcherPid=$fields.launcherPid.GetInt32(); readySha256=$hash
    }
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    Write-AgentsChatColdActivationReceipt $Context 'running'
    return Assert-AgentsChatColdActivatedRuntime $Context
}

function Stop-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    if (-not $Context.Requested -or $Context.Stopped) { return }
    $Context.Stage = 'stop'
    $task = Assert-AgentsChatColdActivationContext $Context
    if ($Context.Enabled) {
        $task.Enabled = $false
        $Context.Enabled = $false
        $Context.Definition = $Context.PlannedDefinition
        $null = Assert-AgentsChatColdActivationContext $Context
    }
    if ($Context.Runtime -and -not $Context.Owner.HasExited) {
        $runtime = $Context.Runtime
        $null = Assert-AgentsChatColdActivatedRuntime $Context
        $stopped = [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'stop', 15000) | ConvertFrom-Json
        if ($stopped.phase -cne 'stopped' -or -not $stopped.quiescent -or $stopped.members.Count -ne 0) {
            throw 'Cold activated Job did not settle.'
        }
        if ([Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'retire', 15000) -cne 'retired' -or
            -not $Context.Owner.WaitForExit(15000) -or $Context.Owner.ExitCode -ne 0) {
            throw 'Cold activated owner did not retire cleanly.'
        }
    } elseif ($Context.Instance) {
        $Context.Instance.Refresh()
        if (([guid]$Context.Instance.InstanceGuid).ToString('D') -cne $Context.InstanceGuid) {
            throw 'Cold activated cleanup instance changed.'
        }
        $Context.Instance.Stop()
        if ($Context.Owner -and -not $Context.Owner.WaitForExit(15000)) { throw 'Cold activated owner did not stop.' }
    }
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ((Assert-AgentsChatColdActivationContext $Context).GetInstances(0).Count -ne 0) {
        if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Cold activated Scheduler instance did not settle.' }
        Start-Sleep -Milliseconds 100
    }
    if ($Context.Runtime) {
        Assert-AgentsChatCompletionProcessAbsent $Context.Runtime.pid $Context.Runtime.identity
        [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$Context.Runtime.generation, $Context.Runtime.sessionId)
    }
    Write-AgentsChatColdActivationReceipt $Context 'stopped'
    $Context.Stopped = $true
}
