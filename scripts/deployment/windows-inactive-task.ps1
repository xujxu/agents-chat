. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-managed-task-definition.ps1')

function Assert-AgentsChatInactiveTask([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Inactive task observation is unavailable.' }
    $Context.Busy = $true
    try {
        foreach ($file in $Context.Files) { $file.Check() }
        $task = $Context.Folder.GetTask($Context.TaskName)
        if ($task.Enabled -or [string]$task.Xml -cne $Context.NativeDefinition -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor -or
            $task.GetInstances(0).Count -ne 0) { throw 'Original inactive task policy or instances changed.' }
        $bundle = [IO.Path]::GetDirectoryName($Context.Configuration)
        $entries = @(Get-ChildItem -LiteralPath $bundle -Force | Where-Object Name -Match '^(runtime|launch)-.*\.json$')
        if ($entries.Count -ne 1 -or $entries[0].Name -cne $Context.ReadyName -or $entries[0].PSIsContainer) {
            throw 'Inactive task has ambiguous runtime or launch evidence.'
        }
        $retired = $Context.RetiredRuntime
        Assert-AgentsChatCompletionProcessAbsent $retired.pid $retired.identity
        [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$retired.generation, $retired.sessionId)
        foreach ($file in $Context.Files) { $file.Check() }
        return [pscustomobject][ordered]@{
            status='inactive-task-observed'; runtimeAuthority=$false
            project=$Context.Project; taskName=$Context.TaskName; definition=$Context.NativeDefinition
            securityDescriptor=$Context.SecurityDescriptor; principalSid=$Context.PrincipalSid; enabled=$false
            configuration=$Context.Configuration; configurationSha256=$Context.ConfigurationSha256
            runtime=$null; retiredRuntime=[pscustomobject]$retired
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Inactive task observation refused.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatInactiveTask([string]$TaskName, [string]$Project) {
    $context = @{
        Project=$Project; TaskName=$TaskName; Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='input'
    }
    try {
        $task = Open-AgentsChatManagedTaskDefinition $context
        if ($task.Enabled -or $task.GetInstances(0).Count -ne 0) {
            throw 'Inactive observation requires an already disabled task without instances.'
        }
        $userId = [string]$task.Definition.Principal.UserId
        $sid = if ($userId -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($userId) }
            else { ([Security.Principal.NTAccount]::new($userId)).Translate([Security.Principal.SecurityIdentifier]) }
        $context.PrincipalSid = $sid.Value
        Open-AgentsChatCompletionConfiguration $context $context.Configuration $context.ConfigurationSha256
        $bundle = [IO.Path]::GetDirectoryName($context.Configuration)
        $entries = @(Get-ChildItem -LiteralPath $bundle -Force | Where-Object Name -Match '^(runtime|launch)-.*\.json$')
        if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or
            $entries[0].Name -cnotmatch '^runtime-[1-9][0-9]*-[1-9][0-9]*\.json$') {
            throw 'Inactive task requires exactly one original readiness record and no guarded launch.'
        }
        $ready = Open-AgentsChatCompletionFile $context $entries[0].FullName ''
        $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
            'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
        $retired = @{
            pid=$fields.pid.GetInt32(); identity=$fields.identity.GetString(); generation=$fields.generation.GetString()
            sessionId=$fields.sessionId.GetInt32(); configurationSha256=$fields.configurationSha256.GetString()
            launcherPid=$fields.launcherPid.GetInt32(); readySha256=$ready.Sha256
        }
        Assert-AgentsChatCompletionGuid $retired.generation
        Assert-AgentsChatCompletionProcessIdentity $retired.pid $retired.identity
        if ($fields.version.GetInt32() -ne 1 -or $retired.sessionId -lt 0 -or $retired.launcherPid -lt 1 -or
            $retired.configurationSha256 -cne $context.ConfigurationSha256 -or
            $fields.job.GetString() -cne "Local\agents-deploy-$($retired.generation)" -or
            $entries[0].Name -cne "runtime-$($retired.identity.Replace(':', '-')).json") {
            throw 'Inactive readiness differs from its original installed configuration.'
        }
        $context.ReadyName = $entries[0].Name
        $context.RetiredRuntime = $retired
        $null = Assert-AgentsChatInactiveTask $context
        $null = Assert-AgentsChatInactiveTask $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Inactive observation and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
