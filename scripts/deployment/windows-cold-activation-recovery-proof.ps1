. (Join-Path $PSScriptRoot 'windows-cold-activation-context.ps1')

function Assert-AgentsChatColdActivationRecoveryProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Cold activation observation is unavailable.'
    }
    $Context.Busy = $true
    try {
        foreach ($pass in @(1, 2)) {
            Assert-AgentsChatStoppedRestoreInventory $Context
            Assert-AgentsChatStoppedRestoreOwnerAbsent $Context
            foreach ($file in $Context.Files) { $file.Check() }
            $original = $Context.Admission
            Assert-AgentsChatCompletionProcessAbsent $original.ownerPid.GetInt32() $original.ownerIdentity.GetString()
            Assert-AgentsChatCompletionProcessAbsent $Context.ColdControllerPid $Context.ColdControllerIdentity
            Assert-AgentsChatCompletionProcessAbsent $Context.ActivationBridgePid $Context.ActivationBridgeIdentity
            Assert-AgentsChatCompletionProcessAbsent $Context.Runtime.pid $Context.Runtime.identity
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$original.generation.GetString(), $Context.RuntimeSessionId)
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$Context.Runtime.generation, $Context.Runtime.sessionId)
            $task = $Context.Folder.GetTask($Context.TaskName)
            if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
                [string]$task.Xml -cne $Context.ColdDefinition -or $task.Definition.Triggers.Count -ne 0 -or
                [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                throw 'Stopped cold activation task policy, security or instance changed.'
            }
        }
        return [ordered]@{
            status='cold-activation-stopped'; mutationAuthority=$false
            operationId=$Context.OperationId; taskName=$Context.TaskName; stateSha256=$Context.StateSha256
            ownerSha256=$Context.ColdOwnerSha256; filesReceiptSha256=$Context.ColdReceiptSha256
            intentSha256=$Context.ColdIntentSha256; historySha256=$Context.ColdHistorySha256
            runtime=$Context.Runtime
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Cold activation observation refused.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatColdActivationRecoveryProof {
    param([string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256,
        [string]$IntentSha256, [string]$HistorySha256)
    $proof = Open-AgentsChatStoppedRestoreEvidence -Control $Control -Recovery -ActivationHistory
    try {
        if (-not $proof.AbsentOwner -or
            ($proof.RecoveryNames -join ',') -cne 'recovery-lock') {
            throw 'Cold activation observation requires an absent original owner and no staged recovery.'
        }
        $ownerFile = Open-AgentsChatCompletionFile $proof (Join-Path $Control 'recovery-lock/owner.json') $OwnerSha256
        $ownerRecord = $ownerFile.ReadText() | ConvertFrom-Json
        Read-AgentsChatColdRestoreRecords $proof $OwnerSha256 $ReceiptSha256 `
            $ownerRecord.owner.pid $ownerRecord.owner.processIdentity
        Read-AgentsChatColdActivationIntent $proof $OwnerSha256 $ReceiptSha256 $IntentSha256
        $schema = @('version', 'phase', 'operationId', 'ownerSha256', 'filesReceiptSha256', 'intentSha256',
            'previousSha256', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
            'securityDescriptor', 'configuration', 'configurationSha256', 'runtime')
        $previous = $IntentSha256
        $first = $running = $null
        foreach ($phase in @('start-requested', 'running', 'stopped')) {
            $file = Open-AgentsChatCompletionFile $proof (Join-Path $Control "recovery-lock/activation-$phase.json") ''
            $record = Read-AgentsChatMaintenanceFields ($file.ReadText()) $schema
            if ($record.version.GetInt32() -ne 1 -or $record.phase.GetString() -cne $phase -or
                $record.operationId.GetString() -cne $proof.OperationId -or
                $record.ownerSha256.GetString() -cne $OwnerSha256 -or
                $record.filesReceiptSha256.GetString() -cne $ReceiptSha256 -or
                $record.intentSha256.GetString() -cne $IntentSha256 -or
                $record.previousSha256.GetString() -cne $previous -or
                $record.taskName.GetString() -cne $proof.TaskName -or
                $record.securityDescriptor.GetString() -cne $proof.SecurityDescriptor -or
                $record.configuration.GetString() -cne $proof.ColdRuntime.configuration.GetString() -or
                $record.configurationSha256.GetString() -cne $proof.ColdRuntime.sha256.GetString()) {
                throw 'Cold activation history differs from its original stopped transaction.'
            }
            Assert-AgentsChatCompletionProcessIdentity $record.controllerPid.GetInt32() $record.controllerIdentity.GetString()
            if ($phase -ceq 'start-requested') {
                if ($record.runtime.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
                    throw 'Cold activation start request already contains a runtime.'
                }
                $first = $record
            } else {
                Assert-AgentsChatCompletionFields $record $first @('controllerPid', 'controllerIdentity', 'definition')
                $runtime = ConvertFrom-AgentsChatCompletionRuntime $record.runtime.GetRawText()
                if ($runtime.generation -ceq $proof.Admission.generation.GetString() -or
                    $runtime.configurationSha256 -cne $proof.ColdRuntime.sha256.GetString() -or
                    $runtime.pid -eq $record.controllerPid.GetInt32()) {
                    throw 'Cold activation history reused or changed its runtime.'
                }
                if ($phase -ceq 'running') { $running = $record }
                else { Assert-AgentsChatCompletionFields $record $running @('runtime') }
            }
            $previous = $file.Sha256
        }
        if ($previous -cne $HistorySha256) { throw 'Original stopped cold history digest changed.' }
        $policy = @{
            Definition=$proof.Definition; Bundle=$proof.ColdRuntime.directory.GetString()
            Configuration=$proof.ColdRuntime.configuration.GetString()
            ConfigurationSha256=$proof.ColdRuntime.sha256.GetString(); Stage='cold-policy'
        }
        $expected = Get-AgentsChatColdActivationDefinition $policy `
            $first.controllerPid.GetInt32() $first.controllerIdentity.GetString()
        if (([xml]$record.definition.GetString()).OuterXml -cne $expected) {
            throw 'Stopped cold task is not its original literal guarded replacement.'
        }
        $proof.ActivationBridgePid = $first.controllerPid.GetInt32()
        $proof.ActivationBridgeIdentity = $first.controllerIdentity.GetString()
        $proof.Runtime = $runtime
        $proof.ColdDefinition = $record.definition.GetString()
        $proof.ColdOwnerSha256 = $OwnerSha256
        $proof.ColdReceiptSha256 = $ReceiptSha256
        $proof.ColdIntentSha256 = $IntentSha256
        $proof.ColdHistorySha256 = $HistorySha256
        Open-AgentsChatCompletionBundle $proof $proof.ColdRuntime.configuration.GetString() `
            $proof.ColdRuntime.sha256.GetString() $runtime
        $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($proof.TaskName)"
        $hash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $proof.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $hash))
        $null = Assert-AgentsChatColdActivationRecoveryProof $proof
        return $proof
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold observation and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
