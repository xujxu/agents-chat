. (Join-Path $PSScriptRoot 'windows-task-completion-records.ps1')

function Assert-AgentsChatCompletionProcessAbsent([int]$ProcessId, [string]$Identity) {
    Assert-AgentsChatCompletionProcessIdentity $ProcessId $Identity
    $process = $null
    try {
        try { $process = [Diagnostics.Process]::GetProcessById($ProcessId) }
        catch {
            if ($_.Exception.GetBaseException() -is [ArgumentException]) { return }
            throw
        }
        $null = $process.Handle
        if (-not $process.HasExited -and "$ProcessId`:$($process.StartTime.ToUniversalTime().Ticks)" -ceq $Identity) {
            throw 'Original completion controller or retired owner is still alive.'
        }
    } finally { if ($process) { $process.Dispose() } }
}

function Assert-AgentsChatCompletionInventory([hashtable]$Context) {
    $Context.Stage = 'inventory'
    if (Test-Path -LiteralPath (Join-Path $Context.Control 'recovery-lock')) { throw 'Exclusive recovery authority exists.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $expected.Add('admission.json')
    $null = $expected.Add('transaction.json')
    foreach ($name in $Context.RecordNames) { $null = $expected.Add("task-$name.json") }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) { throw 'Unsupported completion evidence inventory.' }
    }
    if ($expected.Count) { throw 'Incomplete completion evidence inventory.' }
}

function Assert-AgentsChatCompletionControllers([hashtable]$Context) {
    $Context.Stage = 'original-processes'
    $admission = $Context.Admission
    Assert-AgentsChatCompletionProcessAbsent $admission.controllerPid.GetInt32() $admission.controllerIdentity.GetString()
    Assert-AgentsChatCompletionProcessAbsent $Context.BridgePid $Context.BridgeIdentity
    Assert-AgentsChatCompletionProcessAbsent $admission.ownerPid.GetInt32() $admission.ownerIdentity.GetString()
}

function Open-AgentsChatCompletionBundle([hashtable]$Context, [string]$Configuration, [string]$Sha256, [hashtable]$Runtime) {
    $bundle = [IO.Path]::GetDirectoryName($Configuration)
    $hostFiles = [Deployment.WindowsRuntimeHost]::Open($Configuration, $Sha256, $bundle)
    $Context.Files.Add($hostFiles)
    $config = Open-AgentsChatCompletionFile $Context $Configuration $Sha256
    $document = [Text.Json.JsonDocument]::Parse($config.ReadText())
    try {
        if ($document.RootElement.GetProperty('command').GetProperty('cwd').GetString() -cne $Context.Project) {
            throw 'Completed runtime command differs from the locked project.'
        }
    } finally { $document.Dispose() }
    $readyPath = Join-Path $bundle "runtime-$($Runtime.identity.Replace(':', '-')).json"
    $ready = Open-AgentsChatCompletionFile $Context $readyPath $Runtime.readySha256
    $fields = Read-AgentsChatMaintenanceFields ($ready.ReadText()) @(
        'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid')
    if ($fields.version.GetInt32() -ne 1 -or $fields.generation.GetString() -cne $Runtime.generation -or
        $fields.pid.GetInt32() -ne $Runtime.pid -or $fields.identity.GetString() -cne $Runtime.identity -or
        $fields.configurationSha256.GetString() -cne $Sha256 -or
        $fields.job.GetString() -cne "Local\agents-deploy-$($Runtime.generation)" -or
        $fields.launcherPid.GetInt32() -lt 1 -or $fields.sessionId.GetInt32() -lt 0) {
        throw 'Original private runtime readiness differs.'
    }
    if ($Runtime.ContainsKey('sessionId') -and ($fields.sessionId.GetInt32() -ne $Runtime.sessionId -or
        $fields.launcherPid.GetInt32() -ne $Runtime.launcherPid)) { throw 'Completed runtime readiness differs.' }
}

function Close-AgentsChatTaskCompletionProof {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Completion proof refused: busy.' }
    if ($Context.Closed) { return }
    $Context.Closed = $true
    $failures = [Collections.Generic.List[Exception]]::new()
    for ($index = $Context.Files.Count - 1; $index -ge 0; $index--) {
        try { $Context.Files[$index].Dispose() }
        catch { $failures.Add($_.Exception) }
    }
    if ($Context.Owner) {
        try { $Context.Owner.Dispose() }
        catch { $failures.Add($_.Exception) }
    }
    $Context.Instance = $null
    $Context.Folder = $null
    if ($failures.Count) { throw [AggregateException]::new('Completion proof close failed.', $failures) }
}

function Assert-AgentsChatTaskCompletionProof {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Completion proof is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatCompletionInventory $Context
        Assert-AgentsChatCompletionControllers $Context
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        $runtime = $Context.Runtime
        $Context.Stage = 'runtime-owner'
        if ($Context.Owner.HasExited -or
            "$($runtime.pid):$($Context.Owner.StartTime.ToUniversalTime().Ticks)" -cne $runtime.identity -or
            $Context.Owner.SessionId -ne $runtime.sessionId) { throw 'Original completed runtime exited or changed.' }
        $Context.Stage = 'task-policy'
        $task = $Context.Folder.GetTask($Context.TaskName)
        if ([bool]$task.Enabled -ne $Context.Enabled -or [string]$task.Xml -cne $Context.NativeDefinition -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) { throw 'Completed task policy changed.' }
        $Context.Stage = 'task-instance'
        $Context.Instance.Refresh()
        if (([guid]$Context.Instance.InstanceGuid).ToString('D') -cne $runtime.instanceGuid -or
            [int]$Context.Instance.EnginePID -ne $runtime.pid -or [int]$Context.Instance.State -ne 4 -or
            $Context.Instance.Path -cne "\$($Context.TaskName)") { throw 'Original completed task instance changed.' }
        $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName -OwnerPid $runtime.pid `
            -OwnerIdentity $runtime.identity -Definition $Context.NativeDefinition -SecurityDescriptor $Context.SecurityDescriptor
        if ($binding.instanceGuid -cne $runtime.instanceGuid -or $binding.sessionId -ne $runtime.sessionId -or
            $binding.enabled -ne $Context.Enabled) { throw 'Original completed native binding differs.' }
        $Context.Stage = 'runtime-lease'
        if ([Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity,
            'lease', 15000) -cne 'released') { throw 'Original runtime lease is not released.' }
        $Context.Stage = 'runtime-domain'
        $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity,
            'observe', 15000) | ConvertFrom-Json
        if ($observation.quiescent -or $observation.phase -ceq 'stopped' -or $observation.applicationHealthy -or
            $observation.members -notcontains $runtime.launcherPid) { throw 'Original completed Job is not active.' }
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionInventory $Context
        Assert-AgentsChatCompletionControllers $Context
        $Context.Stage = 'final-native-observation'
        $task = $Context.Folder.GetTask($Context.TaskName)
        $Context.Instance.Refresh()
        if ($Context.Owner.HasExited -or [bool]$task.Enabled -ne $Context.Enabled -or
            [string]$task.Xml -cne $Context.NativeDefinition -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor -or
            ([guid]$Context.Instance.InstanceGuid).ToString('D') -cne $runtime.instanceGuid -or
            [int]$Context.Instance.EnginePID -ne $runtime.pid -or [int]$Context.Instance.State -ne 4 -or
            $task.GetInstances(0).Count -ne 1) { throw 'Completion changed during observation.' }
        return [pscustomobject][ordered]@{
            status='observed'; mutationAuthority=$false; operationId=$Context.OperationId; taskName=$Context.TaskName
            stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
            runtime=[pscustomobject]$runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Completion proof refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatTaskCompletionProof {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Control)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='directories'
    }
    try {
        if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Unsupported completion observer.' }
        foreach ($directory in @($Control, (Join-Path $Control 'lock'), $context.Directory)) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        if (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock')) { throw 'Exclusive recovery authority exists.' }
        Read-AgentsChatTaskCompletionRecords $context
        Assert-AgentsChatCompletionInventory $context
        Assert-AgentsChatCompletionControllers $context
        $context.Stage = 'runtime-record'
        $completed = $context.Completed
        $fields = Read-AgentsChatMaintenanceFields $completed.runtime.GetRawText() @(
            'pid', 'identity', 'generation', 'instanceGuid', 'sessionId', 'configurationSha256', 'launcherPid', 'readySha256')
        $runtime = @{}
        foreach ($name in @('pid', 'sessionId', 'launcherPid')) { $runtime[$name] = $fields[$name].GetInt32() }
        foreach ($name in @('identity', 'generation', 'instanceGuid', 'configurationSha256', 'readySha256')) {
            $runtime[$name] = $fields[$name].GetString()
        }
        Assert-AgentsChatCompletionProcessIdentity $runtime.pid $runtime.identity
        Assert-AgentsChatCompletionGuid $runtime.generation
        Assert-AgentsChatCompletionGuid $runtime.instanceGuid
        if ($runtime.generation -ceq $context.Admission.generation.GetString() -or
            $runtime.identity -ceq $context.Admission.ownerIdentity.GetString() -or
            $runtime.configurationSha256 -cne $context.ConfigurationSha256 -or
            $runtime.launcherPid -lt 1 -or $runtime.sessionId -lt 0) { throw 'Original completed runtime scope differs.' }
        $context.Runtime = $runtime
        $context.Port = $completed.port.GetInt32()
        if ($context.Port -lt 1 -or $context.Port -gt 65535 -or
            $completed.providers.GetArrayLength() -lt 1 -or $completed.providers.GetArrayLength() -gt 3) {
            throw 'Invalid completed readiness scope.'
        }
        $context.Providers = [string[]]@($completed.providers.EnumerateArray() | ForEach-Object { $_.GetString() })
        if (@($context.Providers | Select-Object -Unique).Count -ne $context.Providers.Count -or
            @($context.Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
            throw 'Unsupported completed readiness providers.'
        }
        $context.Stage = 'runtime-bundles'
        $admission = $context.Admission
        Open-AgentsChatCompletionBundle $context $admission.configuration.GetString() $admission.configurationSha256.GetString() @{
            pid=$admission.ownerPid.GetInt32(); identity=$admission.ownerIdentity.GetString()
            generation=$admission.generation.GetString(); readySha256=$admission.readySha256.GetString()
        }
        Open-AgentsChatCompletionBundle $context $context.Configuration $context.ConfigurationSha256 $runtime
        $context.Stage = 'runtime-owner'
        $context.Owner = [Diagnostics.Process]::GetProcessById($runtime.pid)
        $null = $context.Owner.Handle
        if ($context.Owner.HasExited -or "$($runtime.pid):$($context.Owner.StartTime.ToUniversalTime().Ticks)" -cne $runtime.identity) {
            throw 'Original completed runtime is unavailable.'
        }
        $context.Stage = 'task-policy'
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $task = $context.Folder.GetTask($context.TaskName)
        if ([bool]$task.Enabled -ne $context.Enabled -or
            [string]$task.GetSecurityDescriptor(7) -cne $context.SecurityDescriptor) { throw 'Completed task policy differs.' }
        if ($context.Enabled) { Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $context.Definition }
        elseif (([xml][string]$task.Xml).OuterXml -cne ([xml]$context.Definition).OuterXml) { throw 'Completed disabled policy differs.' }
        $context.NativeDefinition = [string]$task.Xml
        $instances = $task.GetInstances(0)
        if ($instances.Count -ne 1) { throw 'Completed task instance is ambiguous.' }
        $context.Instance = $instances.Item(1)
        $context.Stage = 'runtime-listener'
        $listener = [Deployment.WindowsRuntimeListener]::Retain(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $context.Port)
        $context.Files.Add($listener)
        if ($listener.ListenerPid -ne $completed.listenerPid.GetInt32() -or
            $listener.ListenerIdentity -cne $completed.listenerIdentity.GetString() -or
            $listener.CreatedAt -cne $completed.listenerCreatedAt.GetString() -or
            $listener.Address -cne $completed.listenerAddress.GetString() -or
            $listener.PairedRecords -ne $completed.listenerPairedRecords.GetBoolean()) {
            throw 'Listener is not the original completed binding.'
        }
        $null = Assert-AgentsChatTaskCompletionProof -Context $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Completion proof open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof -Context $context }
        catch { throw [AggregateException]::new('Completion proof open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
