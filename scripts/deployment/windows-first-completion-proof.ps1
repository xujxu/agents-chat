. (Join-Path $PSScriptRoot 'windows-first-completion-records.ps1')

function Assert-AgentsChatFirstCompletionEvidence([hashtable]$Context) {
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
}

function Assert-AgentsChatFirstCompletionProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'First completion proof is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatFirstCompletionEvidence $Context
        return [pscustomobject][ordered]@{
            status='first-completion-observed'; mutationAuthority=$false; phase=$Context.Phase
            operationId=$Context.OperationId; taskName=$Context.TaskName
            stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
            runtime=[pscustomobject]$Context.Runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("First completion proof refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Resolve-AgentsChatFirstCompletionPolicy([hashtable]$Context, $Task) {
    $Context.Step = $Context.Phase
    $expected = $Context.StagedDefinition
    switch -CaseSensitive ($Context.Phase) {
        'release-requested' { $Context.Step = 'lease-released' }
        'released' { }
        'policy-restore-requested' {
            if ($Task.Definition.Triggers.Count -eq 1) {
                $expected = $Context.PermanentDisabledDefinition
                $Context.Step = 'permanent-policy-applied'
            } elseif ($Task.Definition.Triggers.Count -ne 0) { throw 'Unrecognized first-completion trigger policy.' }
        }
        'policy-restored' { $expected = $Context.PermanentDisabledDefinition }
        'enable-requested' {
            $expected = $Context.PermanentDisabledDefinition
            if ($Task.Enabled) { $expected = $Context.PermanentDefinition; $Context.Step = 'enable-applied' }
        }
        'complete' {
            if (-not $Task.Enabled) { throw 'Completed first task is not enabled.' }
            $expected = $Context.PermanentDefinition
        }
        default { throw 'Unsupported first-completion prefix.' }
    }
    if ($Task.Enabled -and $Context.Step -cnotin @('enable-applied', 'complete')) {
        throw 'First task enabled before its original enable intent.'
    }
    Confirm-AgentsChatFirstTaskPolicy $expected ([string]$Task.Xml) $Context.AccountSid
    $Context.Enabled = [bool]$Task.Enabled
    $Context.NativeDefinition = [string]$Task.Xml
}

function Retain-AgentsChatFirstCompletionTaskFile([hashtable]$Context) {
    if ($null -ne $Context.TaskFile) { throw 'First-completion task file is already retained.' }
    $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($Context.TaskName)"
    $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $Context.TaskFile = [Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash)
    $Context.Files.Add($Context.TaskFile)
}

function Open-AgentsChatFirstCompletionProof([string]$Control, [switch]$Recovery) {
    $context = @{
        Control=$Control; Files=[Collections.Generic.List[IDisposable]]::new(); Hashes=@{}
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null
        Enabled=$false; Stage='directories'; TaskFile=$null; Recovery=[bool]$Recovery
    }
    try {
        foreach ($directory in @($Control, (Join-Path $Control 'lock'))) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        Read-AgentsChatFirstCompletionRecords $context
        Assert-AgentsChatFirstCompletionControllers $context
        if ($Recovery) {
            $context.Stage = 'recovery-exclusive-evidence'
            $original = $context.ReleaseIntentFile
            $identity = $original.CaptureIdentity()
            $sha256 = $original.Sha256
            $bytes = $original.ByteLength
            $original.Dispose()
            $null = $context.Files.Remove($original)
            $context.ReleaseIntentFile = [Deployment.WindowsPrivateFile]::OpenExclusive(
                (Join-Path $context.Directory 'completion-release-requested.json'),
                $sha256, $identity.Dev, $identity.Ino, $bytes)
            $context.Files.Add($context.ReleaseIntentFile)
        }
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
        if ([string]$task.GetSecurityDescriptor(7) -cne $context.SecurityDescriptor) {
            throw 'Original first-task policy or security differs.'
        }
        Resolve-AgentsChatFirstCompletionPolicy $context $task
        $instances = $task.GetInstances(0)
        if ($instances.Count -ne 1) { throw 'Original first-runtime instance is ambiguous.' }
        $context.Instance = $instances.Item(1)
        Retain-AgentsChatFirstCompletionTaskFile $context
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
