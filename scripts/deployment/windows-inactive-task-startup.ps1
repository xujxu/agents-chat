. (Join-Path $PSScriptRoot 'windows-guarded-task-policy.ps1')

function Open-AgentsChatInactiveTaskListener([hashtable]$Context, [int]$Port) {
    $null = Assert-AgentsChatInactiveTask $Context
    if ($Port -lt 1 -or $Port -gt 65535 -or -not $Context.ContainsKey('Startup') -or
        $Context.Startup.Phase -cne 'running') { throw 'Inactive readiness requires an original running task and valid port.' }
    $runtime = $Context.Startup.Runtime
    if ($Context.ContainsKey('InactiveListener')) {
        $listener = $Context.InactiveListener
        if ($listener.Port -ne $Port) { throw 'Original inactive listener port differs.' }
        $listener.Check()
    } else {
        try {
            $listener = [Deployment.WindowsRuntimeListener]::Retain(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $Port)
        } catch {
            if ($_.Exception.GetBaseException() -isnot [Deployment.WindowsRuntimeListenerNotReadyException]) { throw }
            $null = Assert-AgentsChatInactiveTask $Context
            return @{ status='not-ready' }
        }
        $Context.Files.Add($listener)
        $Context.InactiveListener = $listener
    }
    $null = Assert-AgentsChatInactiveTask $Context
    return [ordered]@{
        status='retained'; generation=$runtime.generation; port=$Port
        pid=$listener.ListenerPid; identity=$listener.ListenerIdentity
        address=$listener.Address; createdAt=$listener.CreatedAt; pairedRecords=$listener.PairedRecords
    }
}

function Assert-AgentsChatInactiveStartup([hashtable]$Context) {
    $startup = $Context.Startup
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ([string]$task.Xml -cne $startup.Definition -or [bool]$task.Enabled -ne $startup.Enabled -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Original inactive startup policy changed.'
    }
    if ($startup.Instance) {
        $startup.Instance.Refresh()
        if ($task.GetInstances(0).Count -ne 1 -or $startup.Instance.Path -cne "\$($Context.TaskName)" -or
            ([guid]$startup.Instance.InstanceGuid).ToString('D') -cne $startup.InstanceGuid) {
            throw 'Original inactive startup instance changed.'
        }
        if ($Context.Owner -and ($Context.Owner.HasExited -or
            [int]$startup.Instance.EnginePID -ne $Context.Owner.Id -or
            [int]$startup.Instance.State -ne 4 -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id) -cne $startup.OwnerIdentity)) {
            throw 'Original inactive startup owner changed.'
        }
    } elseif ($task.GetInstances(0).Count -ne 0) { throw 'Inactive task started before guarded demand-start.' }
    if ($startup.Runtime) {
        $runtime = $startup.Runtime
        $lease = if ($startup.LeaseReleased) { 'released' } else { 'guarded' }
        $domain = [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
        if ($domain.quiescent -or $domain.phase -cnotin @('admitted', 'root-exited') -or
            $domain.members -notcontains $runtime.launcherPid -or $domain.applicationHealthy -or
            [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne $lease) {
            throw 'Inactive startup lost its original guarded runtime Job.'
        }
    }
}

function Write-AgentsChatInactiveStartupReceipt([hashtable]$Context, [string]$Phase) {
    $null = Assert-AgentsChatInactiveTask $Context
    $startup = $Context.Startup
    $prepared = $Context.ActivationPreparation
    $record = [ordered]@{
        version=1; kind='inactive'; phase=$Phase; operationId=$prepared.operationId
        preparationSha256=$Context.ActivationPreparationSha256; previousSha256=$startup.PreviousSha256
        stateSha256=$prepared.stateSha256; controllerPid=$PID; controllerIdentity=$startup.Identity
        taskName=$Context.TaskName; definition=$startup.PlannedDefinition; securityDescriptor=$Context.SecurityDescriptor
        configuration=$prepared.configuration; configurationSha256=$prepared.configurationSha256
        runtime=$startup.Runtime
    }
    $file = Join-Path $Context.AdmissionControl "task-maintenance/inactive-start-$Phase.json"
    $receipt = [Deployment.WindowsPrivateFile]::Publish($file, ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Files.Add($receipt)
    $startup.PreviousSha256 = $receipt.Sha256
    $null = Assert-AgentsChatInactiveTask $Context
    return $receipt.Sha256
}

function Start-AgentsChatInactiveTask([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveTask $Context
    if (-not $Context.ContainsKey('ReplacementSha256')) { throw 'Inactive startup requires completed native replacement.' }
    $prepared = $Context.ActivationPreparation
    $bundle = [IO.Path]::GetDirectoryName($prepared.configuration)
    if (-not $Context.ContainsKey('Startup')) {
        $Context.Startup = @{
            Phase='initial'; Definition=$Context.ReplacementDefinition; PlannedDefinition=$null; Enabled=$false
            Instance=$null; InstanceGuid=$null; OwnerIdentity=$null; Runtime=$null; RequestSha256=$null
            Identity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            LeaseReleased=$false
            PreviousSha256=$Context.ReplacementSha256
        }
    }
    $startup = $Context.Startup
    switch -CaseSensitive ($startup.Phase) {
        'initial' {
            $task = $Context.Folder.GetTask($Context.TaskName)
            if (-not $task.Definition.Settings.AllowDemandStart -or
                [int]$task.Definition.Settings.MultipleInstances -ne 2) {
                throw 'Inactive startup requires demand-start and ignore-new instance policy.'
            }
            $startup.PlannedDefinition = Get-AgentsChatGuardedActivationDefinition @{
                Definition=$startup.Definition; Bundle=$bundle
                Configuration=$prepared.configuration; ConfigurationSha256=$prepared.configurationSha256
            } $PID $startup.Identity
            $startup.RequestSha256 = Write-AgentsChatInactiveStartupReceipt $Context 'requested'
            $startup.Phase = 'requested'
        }
        'requested' {
            $task = $Context.Folder.GetTask($Context.TaskName)
            $definition = $task.Definition
            $null = $Context.Folder.RegisterTask($Context.TaskName, $startup.PlannedDefinition, (4 -bor 16 -bor 32),
                [string]$definition.Principal.UserId, $null, [int]$definition.Principal.LogonType, $null)
            $task = $Context.Folder.GetTask($Context.TaskName)
            if (([xml][string]$task.Xml).OuterXml -cne $startup.PlannedDefinition) {
                throw 'Registered inactive startup policy differs.'
            }
            $startup.Definition = [string]$task.Xml
            $startup.PlannedDefinition = $startup.Definition
            $startup.Phase = 'registered'
        }
        'registered' {
            $intent = [ordered]@{
                version=1; phase='enable-requested'; requestSha256=$startup.RequestSha256
                controllerPid=$PID; controllerIdentity=$startup.Identity
                taskName=$Context.TaskName; configurationSha256=$prepared.configurationSha256
            }
            $Context.Files.Add([Deployment.WindowsPrivateFile]::Publish(
                (Join-Path $bundle 'enable-requested.json'), ($intent | ConvertTo-Json -Compress)))
            $null = Assert-AgentsChatInactiveTask $Context
            $task = $Context.Folder.GetTask($Context.TaskName)
            $task.Enabled = $true
            $task = $Context.Folder.GetTask($Context.TaskName)
            Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $startup.PlannedDefinition
            $startup.Definition = [string]$task.Xml
            $startup.Enabled = $true
            $startup.Phase = 'enabled'
        }
        'enabled' {
            $task = $Context.Folder.GetTask($Context.TaskName)
            $startup.Instance = $task.Run($null)
            if (-not $startup.Instance) { throw 'Inactive demand-start returned no instance.' }
            $startup.InstanceGuid = ([guid]$startup.Instance.InstanceGuid).ToString('D')
            if ([guid]$startup.InstanceGuid -eq [guid]::Empty) { throw 'Inactive demand-start returned an empty instance.' }
            $startup.Phase = 'starting'
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            do {
                $null = Assert-AgentsChatInactiveTask $Context
                $startup.Instance.Refresh()
                if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Inactive task instance did not start.' }
                if ([int]$startup.Instance.EnginePID -lt 1 -or [int]$startup.Instance.State -ne 4) {
                    Start-Sleep -Milliseconds 100
                }
            } while ([int]$startup.Instance.EnginePID -lt 1 -or [int]$startup.Instance.State -ne 4)
            $Context.Owner = [Diagnostics.Process]::GetProcessById([int]$startup.Instance.EnginePID)
            $null = $Context.Owner.Handle
            $startup.OwnerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($Context.Owner.Id)
            if ($startup.OwnerIdentity -ceq $Context.RetiredRuntime.identity) { throw 'Inactive startup reused the original owner.' }
            $startup.Phase = 'started'
        }
        'started' {
            $task = $Context.Folder.GetTask($Context.TaskName)
            $task.Enabled = $false
            $startup.Definition = $startup.PlannedDefinition
            $startup.Enabled = $false
            $startup.Phase = 'inhibited'
        }
        'inhibited' {
            $readyPath = Join-Path $bundle "runtime-$($startup.OwnerIdentity.Replace(':', '-')).json"
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            while (-not (Test-Path -LiteralPath $readyPath)) {
                $null = Assert-AgentsChatInactiveTask $Context
                if ($deadline.ElapsedMilliseconds -ge 30000) { throw 'Inactive startup did not publish readiness.' }
                Start-Sleep -Milliseconds 100
            }
            $ready = Open-AgentsChatCompletionFile $Context $readyPath ''
            $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
                'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
            $generation = $fields.generation.GetString()
            Assert-AgentsChatCompletionGuid $generation
            if ($fields.version.GetInt32() -ne 1 -or $fields.pid.GetInt32() -ne $Context.Owner.Id -or
                $fields.identity.GetString() -cne $startup.OwnerIdentity -or
                $fields.configurationSha256.GetString() -cne $prepared.configurationSha256 -or
                $generation -ceq $Context.RetiredRuntime.generation -or
                $fields.sessionId.GetInt32() -ne $Context.Owner.SessionId -or
                $fields.job.GetString() -cne "Local\agents-deploy-$generation" -or $fields.launcherPid.GetInt32() -lt 1) {
                throw 'Inactive startup readiness differs from its actual owner.'
            }
            $startup.Runtime = [ordered]@{
                pid=$Context.Owner.Id; identity=$startup.OwnerIdentity; generation=$generation
                instanceGuid=$startup.InstanceGuid; sessionId=$Context.Owner.SessionId
                configurationSha256=$prepared.configurationSha256
                launcherPid=$fields.launcherPid.GetInt32(); readySha256=$ready.Sha256
            }
            $startup.Phase = 'observed'
        }
        'observed' {
            $null = Write-AgentsChatInactiveStartupReceipt $Context 'running'
            $startup.Phase = 'running'
        }
        default { throw 'Inactive startup was already attempted or its phase changed.' }
    }
    $null = Assert-AgentsChatInactiveTask $Context
    return [pscustomobject]@{
        status=$(if ($startup.Phase -ceq 'running') { 'guarded-running' } else { 'inactive-startup-progress' })
        step=$startup.Phase; taskName=$Context.TaskName; runtime=$startup.Runtime; definition=$startup.Definition
    }
}
