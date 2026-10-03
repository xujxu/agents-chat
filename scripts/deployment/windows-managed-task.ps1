. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')

function Assert-AgentsChatManagedTask([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Managed task observation is unavailable.' }
    $Context.Busy = $true
    try {
        $Context.Stage = 'retained-files'
        foreach ($file in $Context.Files) { $file.Check() }
        $runtime = $Context.Runtime
        $Context.Stage = 'task-owner'
        $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName -OwnerPid $runtime.pid `
            -OwnerIdentity $runtime.identity -Definition $Context.NativeDefinition -SecurityDescriptor $Context.SecurityDescriptor
        if ($binding.instanceGuid -cne $runtime.instanceGuid -or $binding.sessionId -ne $runtime.sessionId -or
            $binding.principalSid -cne $Context.PrincipalSid -or $binding.enabled -ne $Context.Enabled) {
            throw 'Original managed task binding changed.'
        }
        $Context.Stage = 'runtime-lease'
        if ([Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity,
            'lease', 15000) -cne $Context.Lease) { throw 'Original managed runtime lease changed.' }
        $Context.Stage = 'runtime-domain'
        $domain = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity,
            'observe', 15000) | ConvertFrom-Json
        if ($domain.quiescent -or $domain.phase -ceq 'stopped' -or $domain.applicationHealthy -or
            $domain.members -notcontains $runtime.launcherPid) { throw 'Original managed Job is not active.' }
        $Context.Stage = 'retained-files'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionFinalRuntime $Context
        return [pscustomobject][ordered]@{
            status='managed-task-observed'; runtimeAuthority=$false
            project=$Context.Project; taskName=$Context.TaskName; definition=$Context.NativeDefinition
            securityDescriptor=$Context.SecurityDescriptor; principalSid=$Context.PrincipalSid; enabled=$Context.Enabled
            configuration=$Context.Configuration; configurationSha256=$Context.ConfigurationSha256
            runtime=[pscustomobject]$runtime; lease=$Context.Lease
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Managed task observation refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatManagedTask([string]$TaskName, [string]$Project) {
    $context = @{
        Project=$Project; TaskName=$TaskName; Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='input'
    }
    try {
        if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
            $TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') { throw 'Unsupported managed task discovery.' }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project))
        $context.Stage = 'task-action'
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $task = $context.Folder.GetTask($TaskName)
        if ($task.Path -cne "\$TaskName" -or $task.Definition.Actions.Count -ne 1) { throw 'Ambiguous managed task action.' }
        $action = $task.Definition.Actions.Item(1)
        $arguments = [string]$action.Arguments
        if ([int]$action.Type -ne 0 -or -not [IO.Path]::IsPathRooted([string]$action.Path) -or
            ([string]$action.Path + $arguments + [string]$action.WorkingDirectory) -match '%|\$\(|[\x00\r\n]' -or
            $arguments -cnotmatch '^(-NoProfile -NonInteractive -File "([^"]+)" -Configuration "([^"]+)" -Sha256 ([a-f0-9]{64}))$') {
            throw 'Task is not a literal installed managed runtime.'
        }
        $hostFile = $Matches[2]
        $configuration = $Matches[3]
        $sha256 = $Matches[4]
        $bundle = [IO.Path]::GetDirectoryName($configuration)
        if ([IO.Path]::GetFileName($configuration) -cne 'configuration.json' -or
            $hostFile -cne (Join-Path $bundle 'windows-runtime-host.ps1') -or
            [string]$action.WorkingDirectory -cne $bundle) { throw 'Managed task does not use one installed bundle.' }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($bundle))
        $context.NativeDefinition = [string]$task.Xml
        $context.SecurityDescriptor = [string]$task.GetSecurityDescriptor(7)
        $context.Enabled = [bool]$task.Enabled
        $context.Configuration = $configuration
        $context.ConfigurationSha256 = $sha256
        $context.Stage = 'task-instance'
        $instances = $task.GetInstances(0)
        if ($instances.Count -ne 1) { throw 'Managed task requires one running original instance.' }
        $context.Instance = $instances.Item(1)
        $context.Instance.Refresh()
        $ownerPid = [int]$context.Instance.EnginePID
        $context.Owner = [Diagnostics.Process]::GetProcessById($ownerPid)
        $null = $context.Owner.Handle
        $ownerIdentity = "$ownerPid`:$($context.Owner.StartTime.ToUniversalTime().Ticks)"
        $binding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $ownerPid `
            -OwnerIdentity $ownerIdentity -Definition $context.NativeDefinition -SecurityDescriptor $context.SecurityDescriptor
        $context.PrincipalSid = $binding.principalSid
        $context.Stage = 'runtime-ready'
        $ready = Open-AgentsChatCompletionFile $context (Join-Path $bundle "runtime-$($ownerIdentity.Replace(':', '-')).json") ''
        $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
            'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
        $runtime = @{
            pid=$fields.pid.GetInt32(); identity=$fields.identity.GetString(); generation=$fields.generation.GetString()
            instanceGuid=$binding.instanceGuid; sessionId=$fields.sessionId.GetInt32()
            configurationSha256=$fields.configurationSha256.GetString()
            launcherPid=$fields.launcherPid.GetInt32(); readySha256=$ready.Sha256
        }
        Assert-AgentsChatCompletionGuid $runtime.generation
        Assert-AgentsChatCompletionGuid $runtime.instanceGuid
        if ($fields.version.GetInt32() -ne 1 -or $runtime.pid -ne $ownerPid -or $runtime.identity -cne $ownerIdentity -or
            $runtime.sessionId -ne $binding.sessionId -or $runtime.configurationSha256 -cne $sha256 -or
            $runtime.launcherPid -lt 1 -or $runtime.sessionId -lt 0 -or
            $fields.job.GetString() -cne "Local\agents-deploy-$($runtime.generation)") { throw 'Managed readiness scope differs.' }
        $context.Runtime = $runtime
        $context.Stage = 'runtime-bundle'
        Open-AgentsChatCompletionBundle $context $configuration $sha256 $runtime
        $context.Stage = 'runtime-lease'
        $context.Lease = [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000)
        if ($context.Lease -cnotin @('unguarded', 'released')) { throw 'Guarded activation is not an idle managed deployment.' }
        $null = Assert-AgentsChatManagedTask $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Managed task open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Managed task open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
