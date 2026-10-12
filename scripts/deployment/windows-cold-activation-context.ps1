. (Join-Path $PSScriptRoot 'windows-cold-restore-authority.ps1')
. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')

function Read-AgentsChatColdActivationIntent([hashtable]$Proof, [string]$OwnerSha256,
    [string]$ReceiptSha256, [string]$IntentSha256) {
    $Control = $Proof.Control
    $file = Open-AgentsChatCompletionFile $proof (Join-Path $Control 'recovery-lock/activation-intent.json') $IntentSha256
    $intent = Read-AgentsChatMaintenanceFields ($file.ReadText()) @(
        'version', 'phase', 'ownerSha256', 'filesReceiptSha256', 'operationId', 'backupId',
        'snapshotSha256', 'stateSha256', 'runtimeBundle', 'state')
    if ($intent.version.GetInt32() -ne 1 -or $intent.phase.GetString() -cne 'activation-intent' -or
        $intent.ownerSha256.GetString() -cne $OwnerSha256 -or
        $intent.filesReceiptSha256.GetString() -cne $ReceiptSha256 -or
        $intent.operationId.GetString() -cne $proof.OperationId -or
        $intent.backupId.GetString() -cne $proof.ColdRecord.backupId -or
        $intent.snapshotSha256.GetString() -cne $proof.ColdRecord.snapshotSha256 -or
        $intent.stateSha256.GetString() -cne $proof.StateSha256 -or
        $intent.runtimeBundle.GetRawText() -cne $proof.ColdReceipt.runtimeBundle.GetRawText()) {
        throw 'Cold activation intent differs from its original recovery evidence.'
    }
    $state = Read-AgentsChatMaintenanceFields ($intent.state.GetRawText()) ([string[]]@($proof.InitialState.Keys))
    if ($state.version.GetInt32() -ne 1 -or $state.operation.GetString() -cne 'restore' -or
        $state.phase.GetString() -cne 'restore-activating' -or $state.previousPhase.GetString() -cne 'restoring' -or
        $state.operationId.GetString() -cne $proof.OperationId -or $state.project.GetString() -cne $proof.Project -or
        $state.backupId.GetString() -cne $proof.ColdRecord.backupId -or
        $state.sourceCommit.GetString() -cne $proof.ColdRecord.state.sourceCommit -or
        $state.targetCommit.GetString() -cne $proof.ColdRecord.state.targetCommit -or
        $state.priorRuntime.GetString() -cne 'running' -or
        $state.runtimeIdentity.GetString() -cne $proof.Admission.generation.GetString() -or
        $state.startedAt.GetString() -cne $proof.ColdOwner.createdAt.GetString() -or
        $state.updatedAt.GetString() -cne $proof.ColdOwner.createdAt.GetString() -or
        $state.errorCode.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
        throw 'Cold activation state differs from its original intent.'
    }
}

function Open-AgentsChatColdActivationContext {
    param(
        [string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256, [string]$IntentSha256,
        [int]$ControllerPid, [string]$ControllerIdentity
    )
    $proof = Open-AgentsChatColdRestoreAuthority -Control $Control -OwnerSha256 $OwnerSha256 `
        -ReceiptSha256 $ReceiptSha256 -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
    try {
        if (-not $proof.AbsentOwner) { throw 'Cold activation requires an absent original runtime.' }
        Read-AgentsChatColdActivationIntent $proof $OwnerSha256 $ReceiptSha256 $IntentSha256
        $runtime = $proof.ColdRuntime
        $proof.Files.Add([Deployment.WindowsRuntimeHost]::Open(
            $runtime.configuration.GetString(), $runtime.sha256.GetString(), $runtime.directory.GetString()))
        $context = @{
            Proof=$proof; Control=$Control; Directory=(Join-Path $Control 'recovery-lock')
            Configuration=$runtime.configuration.GetString(); ConfigurationSha256=$runtime.sha256.GetString()
            Bundle=$runtime.directory.GetString(); TaskName=$proof.TaskName
            Definition=$proof.Definition; SecurityDescriptor=$proof.SecurityDescriptor
            PlannedDefinition=$null; Enabled=$false; Attempted=$false; Requested=$false; Runtime=$null
            Owner=$null; Instance=$null; InstanceGuid=$null; Listener=$null; Stopped=$false; Stage='admitted'
            LeaseReleased=$false; CompletionPrepared=$false; CompletionStep=$null
            Identity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            OwnerSha256=$OwnerSha256; ReceiptSha256=$ReceiptSha256; IntentSha256=$IntentSha256
            PreviousSha256=$IntentSha256
        }
        $null = Assert-AgentsChatColdActivationContext $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold activation admission and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Assert-AgentsChatColdActivationContext([hashtable]$Context) {
    $proof = $Context.Proof
    Assert-AgentsChatColdRestoreAuthority $proof
    Assert-AgentsChatCompletionProcessAbsent $proof.Admission.ownerPid.GetInt32() $proof.Admission.ownerIdentity.GetString()
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$proof.Admission.generation.GetString(), $proof.RuntimeSessionId)
    $task = $proof.Folder.GetTask($Context.TaskName)
    if ($task.Path -cne "\$($Context.TaskName)" -or [bool]$task.Enabled -ne $Context.Enabled -or
        [string]$task.Xml -cne $Context.Definition -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Original cold activation task policy changed.'
    }
    return $task
}

function Write-AgentsChatColdActivationReceipt([hashtable]$Context, [string]$Phase) {
    $null = Assert-AgentsChatColdActivationContext $Context
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.Proof.OperationId
        ownerSha256=$Context.OwnerSha256; filesReceiptSha256=$Context.ReceiptSha256
        intentSha256=$Context.IntentSha256; previousSha256=$Context.PreviousSha256
        controllerPid=$PID; controllerIdentity=$Context.Identity; taskName=$Context.TaskName
        definition=$Context.PlannedDefinition; securityDescriptor=$Context.SecurityDescriptor
        configuration=$Context.Configuration; configurationSha256=$Context.ConfigurationSha256
        runtime=$Context.Runtime
    }
    $name = "activation-$Phase.json"
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Directory $name),
        ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Proof.Files.Add($file)
    $Context.Proof.RecoveryFiles['recovery-lock'] = @(@($Context.Proof.RecoveryFiles['recovery-lock']) + $name | Sort-Object)
    $Context.PreviousSha256 = $file.Sha256
    if ($Phase -ceq 'start-requested') { $Context.Requested = $true }
    $null = Assert-AgentsChatColdActivationContext $Context
}

function Get-AgentsChatColdActivationDefinition([hashtable]$Context, [int]$ControllerPid,
    [string]$ControllerIdentity, [switch]$Permanent) {
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { $powershell = $process.MainModule.FileName }
    finally { $process.Dispose() }
    if ($powershell -match '%|\$\(' -or $Context.Configuration -match '%|\$\(') {
        throw 'Cold activation requires literal native runtime paths.'
    }
    $requested = [xml]$Context.Definition
    $namespaces = [Xml.XmlNamespaceManager]::new($requested.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $hostFile = Join-Path $Context.Bundle 'windows-runtime-host.ps1'
    $values = [ordered]@{
        Command=$powershell; WorkingDirectory=$Context.Bundle
        Arguments="-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($Context.Configuration)`" -Sha256 $($Context.ConfigurationSha256)"
    }
    if (-not $Permanent) { $values.Arguments += " -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity" }
    foreach ($name in $values.Keys) {
        $nodes = $requested.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
        if ($nodes.Count -ne 1) { throw 'Cold activation requires one literal native action.' }
        $nodes[0].InnerText = $values[$name]
    }
    Confirm-AgentsChatTaskReplacementPolicy $Context.Definition $requested.OuterXml $Context
    $triggers = $requested.SelectNodes('/t:Task/t:Triggers', $namespaces)
    $restart = $requested.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
    if ($triggers.Count -ne 1 -or $restart.Count -gt 1) { throw 'Unsupported cold task automation shape.' }
    if (-not $Permanent) {
        $triggers[0].IsEmpty = $true
        if ($restart.Count) { $null = $restart[0].ParentNode.RemoveChild($restart[0]) }
    }
    if ($requested.OuterXml.Length -gt 262144) { throw 'Cold activation policy exceeds its evidence budget.' }
    return $requested.OuterXml
}

function Prepare-AgentsChatColdActivationTask([hashtable]$Context) {
    $Context.Stage = 'task-preparation'
    $task = Assert-AgentsChatColdActivationContext $Context
    $definition = $task.Definition
    if ($task.GetInstances(0).Count -ne 0 -or -not $definition.Settings.AllowDemandStart -or
        [int]$definition.Settings.MultipleInstances -ne 2 -or [int]$definition.Principal.LogonType -notin @(2, 3)) {
        throw 'Cold activation requires an empty demand-start task with supported principal and instance policy.'
    }
    $Context.PlannedDefinition = Get-AgentsChatColdActivationDefinition $Context $PID $Context.Identity
    Write-AgentsChatColdActivationReceipt $Context 'start-requested'
    $task = Assert-AgentsChatColdActivationContext $Context
    if ($task.GetInstances(0).Count -ne 0) { throw 'Original task started before cold registration.' }
    $Context.Stage = 'task-registration'
    $null = $Context.Proof.Folder.RegisterTask($Context.TaskName, $Context.PlannedDefinition, (4 -bor 16 -bor 32),
        [string]$definition.Principal.UserId, $null, [int]$definition.Principal.LogonType, $null)
    $task = $Context.Proof.Folder.GetTask($Context.TaskName)
    if (([xml][string]$task.Xml).OuterXml -cne $Context.PlannedDefinition) { throw 'Registered cold activation policy differs.' }
    $Context.Definition = [string]$task.Xml
    $Context.PlannedDefinition = $Context.Definition
    $null = Assert-AgentsChatColdActivationContext $Context
    if ($task.GetInstances(0).Count -ne 0) { throw 'Cold replacement started before demand-start.' }
}
