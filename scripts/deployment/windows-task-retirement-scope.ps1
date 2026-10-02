. (Join-Path $PSScriptRoot 'windows-task-retirement-records.ps1')

function Assert-AgentsChatRetirementInventory([hashtable]$Context) {
    $Context.Stage = 'retirement-inventory'
    if (Test-Path -LiteralPath (Join-Path $Context.Control 'recovery-lock')) { throw 'Exclusive recovery authority exists.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Intent.files.Count; $index++) {
        $null = $expected.Add([IO.Path]::GetFileName($Context.Intent.files[$index].path))
    }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) { throw 'Unexpected retirement receipt inventory.' }
    }
    if ($expected.Count) { throw 'Remaining retirement receipt disappeared.' }
}

function Assert-AgentsChatRetirementControllers([hashtable]$Context) {
    $Context.Stage = 'retirement-processes'
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($Context.ControllerPid) -cne $Context.ControllerIdentity) {
        throw 'Original retirement controller changed.'
    }
    Assert-AgentsChatRetirementCreator $Context.Intent.creator $Context.ControllerPid $Context.ControllerIdentity
    Assert-AgentsChatRetirementCreator $Context.Checkpoint.creator $Context.ControllerPid $Context.ControllerIdentity
    Assert-AgentsChatCompletionProcessAbsent $Context.Intent.lock.pid $Context.Intent.lock.processIdentity
    foreach ($name in @('retiredBridge', 'retiredOwner')) {
        Assert-AgentsChatCompletionProcessAbsent $Context.Checkpoint[$name].pid $Context.Checkpoint[$name].processIdentity
    }
}

function Assert-AgentsChatTaskRetirement([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Retirement authority is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatRetirementInventory $Context
        Assert-AgentsChatRetirementControllers $Context
        $Context.Stage = 'retained-retirement-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
        $Context.Stage = 'retained-retirement-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatRetirementInventory $Context
        Assert-AgentsChatRetirementControllers $Context
        Assert-AgentsChatCompletionFinalRuntime $Context
        return [ordered]@{ status='retiring'; retiredFiles=$Context.Prefix; checkpoint=$Context.Prepared }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Retirement authority refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatTaskRetirement {
    param(
        [Parameter(Mandatory)][string]$Control,
        [Parameter(Mandatory)][int]$ControllerPid,
        [Parameter(Mandatory)][string]$ControllerIdentity
    )
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null
        Stage='retirement-directories'; Prefix=0
    }
    try {
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
        Read-AgentsChatRetirementRecords $context
        $context.Stage = 'retirement-prefix'
        $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in Get-ChildItem -LiteralPath $context.Directory -Force) {
            if ($entry.PSIsContainer -or -not $present.Add($entry.Name)) { throw 'Invalid retirement receipt entry.' }
        }
        $remainingStarted = $false
        $context.Receipts = [object[]]::new($context.Intent.files.Count)
        for ($index = 0; $index -lt $context.Intent.files.Count; $index++) {
            $descriptor = $context.Intent.files[$index]
            if ($present.Remove([IO.Path]::GetFileName($descriptor.path))) {
                $remainingStarted = $true
                $context.Receipts[$index] = Open-AgentsChatRetirementFile $context $descriptor $descriptor.path
            } elseif ($remainingStarted) { throw 'Non-prefix retirement inventory.' }
            else { $context.Prefix++ }
        }
        if ($present.Count) { throw 'Unexpected retirement receipt entry.' }
        $context.Stage = 'retirement-runtime-bundle'
        $runtime = $context.Runtime
        Open-AgentsChatCompletionBundle $context $context.Checkpoint.configuration $runtime.configurationSha256 $runtime
        $context.Stage = 'retirement-runtime-owner'
        $context.Owner = [Diagnostics.Process]::GetProcessById($runtime.pid)
        $null = $context.Owner.Handle
        $context.Stage = 'retirement-task-policy'
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $task = $context.Folder.GetTask($context.TaskName)
        $context.NativeDefinition = [string]$task.Xml
        $context.SecurityDescriptor = [string]$task.GetSecurityDescriptor(7)
        if ((Get-AgentsChatRetirementTextHash $context.NativeDefinition) -cne $context.Checkpoint.definitionSha256 -or
            (Get-AgentsChatRetirementTextHash $context.SecurityDescriptor) -cne $context.Checkpoint.securityDescriptorSha256 -or
            [bool]$task.Enabled -ne $context.Enabled) { throw 'Original retirement task policy differs.' }
        $instances = $task.GetInstances(0)
        if ($instances.Count -ne 1) { throw 'Original retirement task instance is ambiguous.' }
        $context.Instance = $instances.Item(1)
        $context.Stage = 'retirement-listener'
        $listener = [Deployment.WindowsRuntimeListener]::Retain(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $context.Port)
        $context.Files.Add($listener)
        $original = $context.Checkpoint.listener
        if ($listener.ListenerPid -ne $original.pid -or $listener.ListenerIdentity -cne $original.processIdentity -or
            $listener.CreatedAt -cne $original.createdAt -or $listener.Address -cne $original.address -or
            $listener.PairedRecords -ne $original.pairedRecords) { throw 'Original retirement listener differs.' }
        $null = Assert-AgentsChatTaskRetirement $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Retirement open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Retirement open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Remove-AgentsChatNextRetirementFile([hashtable]$Context) {
    $null = Assert-AgentsChatTaskRetirement $Context
    if ($Context.Prefix -ge $Context.Intent.files.Count) { throw 'Retirement receipt list is exhausted.' }
    $target = $null
    try {
        $index = $Context.Prefix
        $descriptor = $Context.Intent.files[$index]
        $original = $Context.Receipts[$index]
        $original.Check()
        $original.Dispose()
        $null = $Context.Files.Remove($original)
        $Context.Receipts[$index] = $null
        $target = [Deployment.WindowsPrivateFile]::RetainForRetirement(
            (Join-Path $Context.Control $descriptor.path), $descriptor.sha256,
            $descriptor.dev, $descriptor.ino, $descriptor.bytes)
        $null = Assert-AgentsChatTaskRetirement $Context
        $target.Check()
        $target.Delete()
        $target = $null
        $Context.Prefix++
        return Assert-AgentsChatTaskRetirement $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally { if ($target) { $target.Dispose() } }
}
