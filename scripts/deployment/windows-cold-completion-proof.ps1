. (Join-Path $PSScriptRoot 'windows-cold-activation-recovery-proof.ps1')

function Read-AgentsChatColdCompletionHistory([hashtable]$Context, [string]$CompletionSha256) {
    if ($Context.ColdHistoryPhase -cne 'running') { throw 'Cold completion requires running activation history.' }
    $policy = @{
        Definition=$Context.Definition; Bundle=$Context.ColdRuntime.directory.GetString()
        Configuration=$Context.ColdRuntime.configuration.GetString()
        ConfigurationSha256=$Context.ColdRuntime.sha256.GetString(); Stage='cold-completion-policy'
        PowerShell=$Context.ColdPowerShell
    }
    $permanent = Get-AgentsChatColdActivationDefinition $policy `
        $Context.ActivationBridgePid $Context.ActivationBridgeIdentity -Permanent
    $original = [xml]$Context.Admission.definition.GetString()
    $ns = [Xml.XmlNamespaceManager]::new($original.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $enabled = $original.SelectNodes('/t:Task/t:Settings/t:Enabled', $ns)
    if ($enabled.Count -gt 1 -or ($enabled.Count -eq 1 -and $enabled[0].InnerText -cnotin @('true', 'false'))) {
        throw 'Cold completion original enabled policy is unsupported.'
    }
    $targetEnabled = $enabled.Count -eq 0 -or $enabled[0].InnerText -ceq 'true'
    $staged = [xml]$Context.ColdDefinition
    $argumentPath = '/t:Task/t:Actions/t:Exec/t:Arguments'
    $staged.SelectSingleNode($argumentPath, $ns).InnerText =
        ([xml]$permanent).SelectSingleNode($argumentPath, $ns).InnerText
    $binding = @('operationId', 'ownerSha256', 'filesReceiptSha256', 'intentSha256', 'historySha256', 'stateSha256',
        'controllerPid', 'controllerIdentity', 'runtime', 'taskName', 'configuration', 'configurationSha256',
        'guardedDefinition', 'stagedDefinition', 'permanentDefinition', 'targetEnabled', 'securityDescriptor',
        'port', 'providers', 'listenerPid', 'listenerIdentity', 'listenerAddress', 'listenerCreatedAt', 'listenerPairedRecords')
    $schema = @('version', 'phase', 'previousSha256') + $binding + @('definition', 'enabled', 'lease')
    $phases = @('prepared', 'policy-requested', 'policy-staged', 'release-requested', 'released',
        'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete')
    if ($Context.CompletionRecovery) { $phases = $Context.CompletionPhases }
    $previous = $Context.ColdHistorySha256
    $first = $null
    $definition = $Context.ColdDefinition
    $lease = 'guarded'
    foreach ($phase in $phases) {
        $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control "recovery-lock/completion-$phase.json") ''
        if ($file.ByteLength -gt 1048576) { throw 'Oversized cold completion receipt.' }
        $record = Read-AgentsChatMaintenanceFields ($file.ReadText()) $schema
        if ($phase -ceq 'policy-staged') { $definition = $staged.OuterXml }
        if ($phase -ceq 'released') { $lease = 'released' }
        if ($phase -ceq 'policy-restored') { $definition = $permanent }
        if ($record.version.GetInt32() -ne 1 -or $record.phase.GetString() -cne $phase -or
            $record.previousSha256.GetString() -cne $previous -or
            $record.historySha256.GetString() -cne $Context.ColdHistorySha256 -or
            $record.stateSha256.GetString() -cne $Context.StateSha256 -or
            $record.targetEnabled.GetBoolean() -ne $targetEnabled -or
            $record.enabled.GetBoolean() -ne ($phase -ceq 'complete' -and $targetEnabled) -or
            $record.lease.GetString() -cne $lease -or
            ([xml]$record.guardedDefinition.GetString()).OuterXml -cne ([xml]$Context.ColdDefinition).OuterXml -or
            ([xml]$record.stagedDefinition.GetString()).OuterXml -cne $staged.OuterXml -or
            ([xml]$record.permanentDefinition.GetString()).OuterXml -cne ([xml]$permanent).OuterXml) {
            throw 'Cold completion differs from its original binding or durable policy progression.'
        }
        Assert-AgentsChatCompletionFields $record $Context.ColdRunningRecord @(
            'operationId', 'ownerSha256', 'filesReceiptSha256', 'intentSha256', 'controllerPid',
            'controllerIdentity', 'runtime', 'taskName', 'configuration', 'configurationSha256', 'securityDescriptor')
        if ($first) { Assert-AgentsChatCompletionFields $record $first $binding }
        else { $first = $record }
        if ($phase -ceq 'complete' -and $targetEnabled) {
            Confirm-AgentsChatTaskInhibition $record.definition.GetString() $definition
        } elseif (([xml]$record.definition.GetString()).OuterXml -cne ([xml]$definition).OuterXml) {
            throw 'Cold completion changed policy outside its acknowledged registration boundary.'
        }
        $previous = $file.Sha256
    }
    if ($previous -cne $CompletionSha256) { throw 'Original cold completion digest changed.' }
    $Context.CompletionSha256 = $CompletionSha256
    $Context.Configuration = $record.configuration.GetString()
    $Context.ConfigurationSha256 = $record.configurationSha256.GetString()
    $Context.Enabled = $targetEnabled
    $Context.Completed = $record
    $Context.CompletionRecord = $record
    $Context.CompletionSchema = $schema
    $Context.Phase = $phase
}

function Assert-AgentsChatColdCompletionEvidence([hashtable]$Context) {
    foreach ($pass in @(1, 2)) {
        Assert-AgentsChatStoppedRestoreInventory $Context
        Assert-AgentsChatStoppedRestoreOwnerAbsent $Context
        $original = $Context.Admission
        Assert-AgentsChatCompletionProcessAbsent $original.ownerPid.GetInt32() $original.ownerIdentity.GetString()
        Assert-AgentsChatCompletionProcessAbsent $Context.ColdControllerPid $Context.ColdControllerIdentity
        Assert-AgentsChatCompletionProcessAbsent $Context.ActivationBridgePid $Context.ActivationBridgeIdentity
        [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
            [guid]$original.generation.GetString(), $Context.RuntimeSessionId)
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
    }
    Assert-AgentsChatCompletionFinalRuntime $Context
}

function Assert-AgentsChatColdCompletionProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Cold completion observation is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatColdCompletionEvidence $Context
        $observation = [ordered]@{
            status=$(if ($Context.CompletionRecovery) { 'cold-completion-recovery' } else { 'cold-runtime-completed' })
            mutationAuthority=$Context.CompletionRecovery
            operationId=$Context.OperationId; taskName=$Context.TaskName; stateSha256=$Context.StateSha256
            ownerSha256=$Context.ColdOwnerSha256; filesReceiptSha256=$Context.ColdReceiptSha256
            intentSha256=$Context.ColdIntentSha256; historySha256=$Context.ColdHistorySha256
            runtime=$Context.Runtime; completionSha256=$Context.CompletionSha256
            port=$Context.Port; providers=$Context.Providers; lease='released'
        }
        if ($Context.CompletionRecovery) {
            $observation['phase'] = $Context.Phase
            $observation['step'] = $Context.Step
        }
        return $observation
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Cold completion observation refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatColdCompletionProof {
    param([string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256,
        [string]$IntentSha256, [string]$HistorySha256, [string]$CompletionSha256)
    $proof = Open-AgentsChatStoppedRestoreEvidence -Control $Control -Recovery -ActivationHistory -CompletionHistory
    try {
        Read-AgentsChatColdActivationRecoveryHistory $proof $OwnerSha256 $ReceiptSha256 $IntentSha256 $HistorySha256
        Read-AgentsChatColdCompletionHistory $proof $CompletionSha256
        Initialize-AgentsChatCompletionRuntime $proof $proof.Completed
        if ($proof.NativeEnabled -ne $proof.Enabled -or
            $proof.NativeDefinition -cne $proof.Completed.definition.GetString()) {
            throw 'Completed cold runtime no longer has its exact acknowledged native policy.'
        }
        Retain-AgentsChatColdRecoveryTaskFile $proof
        $null = Assert-AgentsChatColdCompletionProof $proof
        return $proof
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold completion observation and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
