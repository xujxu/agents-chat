. (Join-Path $PSScriptRoot 'windows-first-completion-records.ps1')

function Assert-AgentsChatFirstCompletionProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'First completion proof is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatFirstCompletionInventory $Context
        Assert-AgentsChatFirstCompletionControllers $Context
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatFirstCompletionInventory $Context
        Assert-AgentsChatFirstCompletionControllers $Context
        Assert-AgentsChatCompletionFinalRuntime $Context
        return [pscustomobject][ordered]@{
            status='first-completion-observed'; mutationAuthority=$false; phase='release-requested'
            operationId=$Context.OperationId; taskName=$Context.TaskName
            stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
            runtime=[pscustomobject]$Context.Runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("First completion proof refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatFirstCompletionProof([string]$Control) {
    $context = @{
        Control=$Control; Files=[Collections.Generic.List[IDisposable]]::new(); Hashes=@{}
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null
        Enabled=$false; Stage='directories'
    }
    try {
        foreach ($directory in @($Control, (Join-Path $Control 'lock'))) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        Read-AgentsChatFirstCompletionRecords $context
        Assert-AgentsChatFirstCompletionControllers $context
        $context.Stage = 'runtime-bundle'
        $runtime = $context.Runtime
        Open-AgentsChatCompletionBundle $context $context.Configuration $context.ConfigurationSha256 $runtime
        $context.Stage = 'runtime-owner'
        $context.Owner = [Diagnostics.Process]::GetProcessById($runtime.pid)
        $null = $context.Owner.Handle
        if ($context.Owner.HasExited -or "$($runtime.pid):$($context.Owner.StartTime.ToUniversalTime().Ticks)" -cne $runtime.identity) {
            throw 'Original first runtime is unavailable.'
        }
        $context.Stage = 'task-policy'
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $task = $context.Folder.GetTask($context.TaskName)
        if ($task.Enabled -or [string]$task.GetSecurityDescriptor(7) -cne $context.SecurityDescriptor) {
            throw 'Original first-task policy or security differs.'
        }
        Confirm-AgentsChatFirstTaskPolicy $context.Definition ([string]$task.Xml) $context.AccountSid
        $context.NativeDefinition = [string]$task.Xml
        $instances = $task.GetInstances(0)
        if ($instances.Count -ne 1) { throw 'Original first-runtime instance is ambiguous.' }
        $context.Instance = $instances.Item(1)
        $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($context.TaskName)"
        $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash))
        $context.Stage = 'runtime-listener'
        $listener = [Deployment.WindowsRuntimeListener]::Retain(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $context.Port)
        $context.Files.Add($listener)
        $record = $context.ListenerRecord
        if ($listener.ListenerPid -ne $record.pid.GetInt32() -or $listener.ListenerIdentity -cne $record.identity.GetString() -or
            $listener.Address -cne $record.address.GetString() -or $listener.CreatedAt -cne $record.createdAt.GetString() -or
            $listener.PairedRecords -ne $record.pairedRecords.GetBoolean()) { throw 'Original first listener differs.' }
        $null = Assert-AgentsChatFirstCompletionProof $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("First completion proof open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('First proof open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
