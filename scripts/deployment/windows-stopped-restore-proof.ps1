. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-restore-workers.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-restore-recovery.ps1')

function Assert-AgentsChatStoppedRestoreInventory([hashtable]$Context) {
    $Context.Stage = 'inventory'
    Assert-AgentsChatCompletionInventory $Context -AllowRecovery:$Context.Recovery
    if (-not $Context.Recovery -and (Test-Path -LiteralPath (Join-Path $Context.Control 'cold-restore-staging'))) {
        throw 'Stopped restore conflicts with staged recovery authority.'
    }
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) {
            throw 'Stopped restore conflicts with existing retirement authority.'
        }
    }
    if ($Context.ContainsKey('WorkerNames')) { Assert-AgentsChatStoppedRestoreWorkerInventory $Context }
    if ($Context.ContainsKey('RecoveryNames')) { Assert-AgentsChatStoppedRestoreRecoveryInventory $Context }
}

function Assert-AgentsChatStoppedRestoreOwnerAbsent([hashtable]$Context) {
    $Context.Stage = 'original-processes'
    Assert-AgentsChatCompletionProcessAbsent $Context.Admission.controllerPid.GetInt32() `
        $Context.Admission.controllerIdentity.GetString()
}

function Read-AgentsChatStoppedRestoreState([hashtable]$Context) {
    $Context.Stage = 'state'
    $initial = $Context.InitialState
    if ($initial.operation -cne 'restore' -or $initial.phase -cne 'restoring' -or
        $initial.previousPhase -cne 'restore-preflight') { throw 'Original stop is not a restore transaction.' }
    $stateFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') ''
    if ((Get-Item -LiteralPath (Join-Path $Context.Control 'state.json')).Length -gt 65536) {
        throw 'Oversized stopped restore state.'
    }
    $fields = Read-AgentsChatMaintenanceFields ($stateFile.ReadText()) ([string[]]@($initial.Keys))
    $state = @{ version=$fields.version.GetInt32() }
    foreach ($name in $fields.Keys) {
        if ($name -cne 'version') { $state[$name] = $fields[$name].GetString() }
    }
    foreach ($name in $initial.Keys) {
        if ($name -cnotin @('phase', 'previousPhase', 'updatedAt', 'errorCode') -and
            $state[$name] -cne $initial[$name]) { throw 'Stopped restore identity changed.' }
    }
    if ($state.phase -ceq 'restoring') {
        if ($stateFile.Sha256 -cne $Context.InitialStateSha256) { throw 'Original restoring state changed.' }
    } elseif ($state.phase -ceq 'recovery-required') {
        if ($state.previousPhase -cne 'restoring' -or $state.errorCode -cnotmatch '^[a-zA-Z0-9_.:-]+$') {
            throw 'Restore failure is not an original stopped prefix.'
        }
        $updated = [DateTimeOffset]::ParseExact($state.updatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $prior = [DateTimeOffset]::ParseExact($initial.updatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($updated -lt $prior) { throw 'Stopped restore state predates its initial stop.' }
    } else { throw 'Restore has advanced beyond its original stopped prefix.' }
    $Context.StateSha256 = $stateFile.Sha256
}

function Assert-AgentsChatStoppedRestoreRuntime([hashtable]$Context) {
    $admission = $Context.Admission
    $Context.Stage = 'runtime-owner'
    if ($Context.AbsentOwner) {
        if (-not $Context.Recovery) { throw 'Absent original runtime requires explicit cold recovery admission.' }
        Assert-AgentsChatCompletionProcessAbsent $admission.ownerPid.GetInt32() $admission.ownerIdentity.GetString()
    } elseif ($Context.Owner.HasExited -or
        "$($Context.Owner.Id):$($Context.Owner.StartTime.ToUniversalTime().Ticks)" -cne $admission.ownerIdentity.GetString()) {
        throw 'Original stopped runtime owner exited or changed.'
    }
    $Context.Stage = 'task-policy'
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or [string]$task.Xml -cne $Context.Definition -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Original stopped task policy changed.'
    }
    if ($Context.AbsentOwner) {
        $Context.Stage = 'absent-runtime-domain'
        if ($task.GetInstances(0).Count -ne 0) { throw 'Absent original runtime has a Scheduler instance.' }
        [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$admission.generation.GetString(), $Context.RuntimeSessionId)
        return
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $Context.TaskName `
        -OwnerPid $admission.ownerPid.GetInt32() -OwnerIdentity $admission.ownerIdentity.GetString() `
        -Definition $Context.Definition -SecurityDescriptor $Context.SecurityDescriptor
    if ($binding.enabled -or $binding.instanceGuid -cne $admission.instanceGuid.GetString() -or
        $binding.sessionId -ne $Context.Owner.SessionId) { throw 'Original stopped task instance differs.' }
    $Context.Stage = 'runtime-domain'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$admission.generation.GetString(),
        $admission.ownerPid.GetInt32(), $admission.ownerIdentity.GetString(), 'observe', 15000) | ConvertFrom-Json
    if ($observation.phase -cne 'stopped' -or -not $observation.quiescent -or $observation.members.Count -ne 0) {
        throw 'Original stopped runtime retains writers.'
    }
}

function Assert-AgentsChatStoppedRestoreProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Stopped restore proof is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatStoppedRestoreInventory $Context
        Assert-AgentsChatStoppedRestoreOwnerAbsent $Context
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatStoppedRestoreRuntime $Context
        $Context.Stage = 'retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatStoppedRestoreInventory $Context
        Assert-AgentsChatStoppedRestoreOwnerAbsent $Context
        Assert-AgentsChatStoppedRestoreRuntime $Context
        return [pscustomobject][ordered]@{
            status='observed'; mutationAuthority=$false; operationId=$Context.OperationId
            taskName=$Context.TaskName; stateSha256=$Context.StateSha256; stopped=$true; inhibited=$true
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Stopped restore proof refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatStoppedRestoreEvidence {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Control, [switch]$Recovery, [switch]$ActivationHistory,
        [switch]$PolicyRecovery, [switch]$CompletionHistory)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='directories'
        Recovery=[bool]$Recovery; ActivationHistory=[bool]$ActivationHistory
        PolicyRecovery=[bool]$PolicyRecovery; CompletionHistory=[bool]$CompletionHistory
        AbsentOwner=$false; RuntimeSessionId=$null
    }
    try {
        if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows -or
            $Control -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Control) -cne $Control -or
            ($ActivationHistory -and -not $Recovery) -or ($PolicyRecovery -and -not $ActivationHistory) -or
            ($CompletionHistory -and (-not $ActivationHistory -or $PolicyRecovery))) {
            throw 'Stopped restore proof requires native Windows and canonical control.'
        }
        foreach ($directory in @($Control, (Join-Path $Control 'lock'), $context.Directory)) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        $context.RecordNames = @('stop-intent', 'stop-inhibited', 'stop-stop-requested', 'stop-stopped')
        Assert-AgentsChatStoppedRestoreInventory $context
        Read-AgentsChatTaskCompletionHistory $context $context.RecordNames -StoppedOnly
        Assert-AgentsChatStoppedRestoreOwnerAbsent $context
        Read-AgentsChatStoppedRestoreState $context
        Open-AgentsChatStoppedRestoreWorkers $context
        if ($Recovery) { Open-AgentsChatStoppedRestoreRecoveryFiles $context }
        $admission = $context.Admission
        $context.Stage = 'runtime-bundle'
        Open-AgentsChatCompletionBundle $context $admission.configuration.GetString() $admission.configurationSha256.GetString() @{
            pid=$admission.ownerPid.GetInt32(); identity=$admission.ownerIdentity.GetString()
            generation=$admission.generation.GetString(); readySha256=$admission.readySha256.GetString()
        } -RetainSession
        $context.Stage = 'runtime-owner'
        try {
            $context.Owner = [Diagnostics.Process]::GetProcessById($admission.ownerPid.GetInt32())
            $null = $context.Owner.Handle
        } catch [ArgumentException] {
            if (-not $Recovery) { throw }
            $context.AbsentOwner = $true
        }
        if ($context.Owner -and ($context.Owner.HasExited -or
            "$($context.Owner.Id):$($context.Owner.StartTime.ToUniversalTime().Ticks)" -cne $admission.ownerIdentity.GetString())) {
            if (-not $Recovery) { throw 'Original stopped runtime owner exited or changed.' }
            $context.Owner.Dispose()
            $context.Owner = $null
            $context.AbsentOwner = $true
        }
        $context.Stage = 'task-policy'
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Stopped restore evidence open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Stopped evidence and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Open-AgentsChatStoppedRestoreProof {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Control, [switch]$Recovery)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = Open-AgentsChatStoppedRestoreEvidence -Control $Control -Recovery:$Recovery
    try {
        $admission = $context.Admission
        $task = $context.Folder.GetTask($context.TaskName)
        $bundle = [IO.Path]::GetDirectoryName($admission.configuration.GetString())
        $hostFile = Join-Path $bundle 'windows-runtime-host.ps1'
        $arguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($admission.configuration.GetString())`" -Sha256 $($admission.configurationSha256.GetString())"
        if ($task.Definition.Actions.Count -ne 1 -or
            [string]$task.Definition.Actions.Item(1).Arguments -cne $arguments -or
            [string]$task.Definition.Actions.Item(1).WorkingDirectory -cne $bundle) {
            throw 'Original stopped task is not its admitted literal runtime host.'
        }
        $null = Assert-AgentsChatStoppedRestoreProof $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Stopped restore proof open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Stopped restore proof and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
