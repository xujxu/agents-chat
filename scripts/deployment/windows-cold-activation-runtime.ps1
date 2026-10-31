function Assert-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    $null = Assert-AgentsChatColdActivationContext $Context
    $runtime = $Context.Runtime
    if (-not $runtime -or $Context.Stopped -or $Context.Owner.HasExited -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity) {
        throw 'Original cold activated runtime exited or changed.'
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName -OwnerPid $runtime.pid `
        -OwnerIdentity $runtime.identity -Definition $Context.Definition -SecurityDescriptor $Context.SecurityDescriptor
    if ([bool]$binding.enabled -ne $Context.Enabled -or $binding.instanceGuid -cne $runtime.instanceGuid -or
        $binding.sessionId -ne $runtime.sessionId) { throw 'Original cold activated Scheduler instance changed.' }
    $domain = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
    $lease = if ($Context.LeaseReleased) { 'released' } else { 'guarded' }
    if ($domain.phase -cnotin @('admitted', 'root-exited') -or $domain.quiescent -or $domain.applicationHealthy -or
        $domain.members -notcontains $runtime.launcherPid -or
        [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne $lease) {
        throw 'Cold activated runtime lacks its original leased Job.'
    }
    $null = Assert-AgentsChatColdActivationContext $Context
    return [ordered]@{
        status=$(if ($Context.LeaseReleased) { 'released-running' } else { 'guarded-running' })
        taskName=$Context.TaskName; runtime=$runtime
        controllerPid=$PID; controllerIdentity=$Context.Identity; configuration=$Context.Configuration
        definition=$Context.Definition; securityDescriptor=$Context.SecurityDescriptor
    }
}

function Start-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    $null = Assert-AgentsChatColdActivationContext $Context
    switch -CaseSensitive ($Context.StartupStep) {
        'initial' {
            Request-AgentsChatColdActivationTask $Context
            $Context.StartupStep = 'requested'
        }
        'requested' {
            Register-AgentsChatColdActivationTask $Context
            $Context.StartupStep = 'registered'
        }
        'registered' {
            Write-AgentsChatColdEnableRequest $Context
            $Context.Stage = 'enable'
            $task = Assert-AgentsChatColdActivationContext $Context
            $task.Enabled = $true
            $task = $Context.Proof.Folder.GetTask($Context.TaskName)
            Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $Context.PlannedDefinition
            $Context.Definition = [string]$task.Xml
            $Context.Enabled = $true
            $Context.StartupStep = 'enabled'
        }
        'enabled' {
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
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id) -ceq $Context.Proof.Admission.ownerIdentity.GetString()) {
                throw 'Cold activation reused its original owner.'
            }
            $Context.StartupStep = 'started'
        }
        'started' {
            $Context.Stage = 'inhibit'
            $task = Assert-AgentsChatColdActivationContext $Context
            $task.Enabled = $false
            $Context.Enabled = $false
            $Context.Definition = $Context.PlannedDefinition
            $Context.StartupStep = 'inhibited'
        }
        'inhibited' {
            $Context.Stage = 'readiness'
            $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id)
            $readyPath = Join-Path $Context.Bundle "runtime-$($identity.Replace(':', '-')).json"
            $deadline = [Diagnostics.Stopwatch]::StartNew()
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
            $Context.StartupStep = 'observed'
        }
        'observed' {
            $null = Assert-AgentsChatColdActivatedRuntime $Context
            Write-AgentsChatColdActivationReceipt $Context 'running'
            $Context.StartupStep = 'running'
            return Assert-AgentsChatColdActivatedRuntime $Context
        }
        default { throw 'Cold activation was already attempted or its startup step changed.' }
    }
    $null = Assert-AgentsChatColdActivationContext $Context
    return @{
        status='cold-startup-progress'; step=$Context.StartupStep
        observation=$(if ($Context.StartupStep -ceq 'observed') {
            Assert-AgentsChatColdActivatedRuntime $Context
        } else { $null })
    }
}

function Open-AgentsChatColdActivatedListener([hashtable]$Context, [int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Cold readiness requires a valid listener port.' }
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    if ($Context.Listener) {
        if ($Context.Listener.Port -ne $Port) { throw 'Original cold listener port differs.' }
        $Context.Listener.Check()
    } else {
        $runtime = $Context.Runtime
        try {
            $Context.Listener = [Deployment.WindowsRuntimeListener]::Retain(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $Port)
        } catch {
            if ($_.Exception.GetBaseException() -isnot [Deployment.WindowsRuntimeListenerNotReadyException]) { throw }
            $null = Assert-AgentsChatColdActivatedRuntime $Context
            return @{ status='not-ready' }
        }
        $Context.Proof.Files.Add($Context.Listener)
    }
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    return [ordered]@{
        status='retained'; generation=$Context.Runtime.generation; port=$Port
        pid=$Context.Listener.ListenerPid; identity=$Context.Listener.ListenerIdentity
        address=$Context.Listener.Address; createdAt=$Context.Listener.CreatedAt; pairedRecords=$Context.Listener.PairedRecords
    }
}

function Stop-AgentsChatColdActivatedRuntime([hashtable]$Context) {
    if (-not $Context.Requested -or $Context.Stopped -or $Context.LeaseReleased) { return }
    $Context.Stage = 'stop'
    $task = Assert-AgentsChatColdActivationContext $Context
    if ($Context.Listener) {
        $Context.Listener.Check()
        $Context.Listener.Dispose()
        $null = $Context.Proof.Files.Remove($Context.Listener)
        $Context.Listener = $null
    }
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
