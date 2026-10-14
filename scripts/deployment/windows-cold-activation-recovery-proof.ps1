. (Join-Path $PSScriptRoot 'windows-cold-activation-context.ps1')
. (Join-Path $PSScriptRoot 'windows-cold-policy-history.ps1')

function Retain-AgentsChatColdRecoveryTaskFile([hashtable]$Context) {
    $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($Context.TaskName)"
    $hash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $Context.TaskFile = [Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $hash)
    $Context.Files.Add($Context.TaskFile)
}

function Assert-AgentsChatColdLaunchInventory([hashtable]$Context) {
    $entries = @(Get-ChildItem -LiteralPath $Context.ColdRuntime.directory.GetString() -Force |
        Where-Object { $_.Name -like 'launch-*.json' })
    if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or
        $entries[0].Name -cne "launch-$($Context.ColdLaunch.identity.Replace(':', '-')).json") {
        throw 'Cold recovery requires exactly its original private launch record.'
    }
}

function Open-AgentsChatColdLaunchProof([hashtable]$Context) {
    $bundle = $Context.ColdRuntime.directory.GetString()
    Open-AgentsChatCompletionConfiguration $Context $Context.ColdRuntime.configuration.GetString() `
        $Context.ColdRuntime.sha256.GetString()
    $entries = @(Get-ChildItem -LiteralPath $bundle -Force | Where-Object { $_.Name -like 'launch-*.json' })
    if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Length -gt 65536) {
        throw 'Cold recovery requires exactly one bounded original launch record.'
    }
    $file = Open-AgentsChatCompletionFile $Context $entries[0].FullName ''
    $fields = Read-AgentsChatMaintenanceFields ($file.ReadText()) @(
        'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job',
        'controllerPid', 'controllerIdentity')
    $launch = @{
        version=$fields.version.GetInt32(); generation=$fields.generation.GetString()
        pid=$fields.pid.GetInt32(); identity=$fields.identity.GetString()
        configurationSha256=$fields.configurationSha256.GetString(); sessionId=$fields.sessionId.GetInt32()
        job=$fields.job.GetString(); controllerPid=$fields.controllerPid.GetInt32()
        controllerIdentity=$fields.controllerIdentity.GetString()
    }
    Assert-AgentsChatCompletionProcessIdentity $launch.pid $launch.identity
    if ($launch.version -ne 1 -or $launch.generation -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
        [guid]$launch.generation -eq [guid]::Empty -or
        $launch.generation -ceq $Context.Admission.generation.GetString() -or $launch.sessionId -lt 0 -or
        $launch.configurationSha256 -cne $Context.ColdRuntime.sha256.GetString() -or
        $launch.job -cne "Local\agents-deploy-$($launch.generation)" -or
        $launch.controllerPid -ne $Context.ActivationBridgePid -or
        $launch.controllerIdentity -cne $Context.ActivationBridgeIdentity -or
        $launch.pid -eq $launch.controllerPid) {
        throw 'Original cold launch controller, configuration or new runtime identity differs.'
    }
    $Context.ColdLaunch = $launch
    $Context.ColdLaunchSha256 = $file.Sha256
    Assert-AgentsChatColdLaunchInventory $Context
}

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
            $inactive = $Context.Runtime
            if (-not $inactive) {
                Assert-AgentsChatColdLaunchInventory $Context
                $inactive = $Context.ColdLaunch
            }
            Assert-AgentsChatCompletionProcessAbsent $inactive.pid $inactive.identity
            if ($Context.PolicyRecovery) { Assert-AgentsChatColdPolicyOwnersAbsent $Context }
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$original.generation.GetString(), $Context.RuntimeSessionId)
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$inactive.generation, $inactive.sessionId)
            $task = $Context.Folder.GetTask($Context.TaskName)
            if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
                [string]$task.Xml -cne $Context.CurrentDefinition -or
                (-not $Context.PolicyRecovery -and $task.Definition.Triggers.Count -ne 0) -or
                [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                throw 'Inactive cold activation task policy, security or instance changed.'
            }
        }
        $observation = [ordered]@{
            status=$(if ($Context.PolicyRecovery) { 'cold-policy-recovery' }
            elseif ($Context.ColdHistoryPhase -ceq 'stopped') {
                'cold-activation-stopped'
            } else { 'cold-activation-inactive' })
            mutationAuthority=$Context.PolicyRecovery
            operationId=$Context.OperationId; taskName=$Context.TaskName; stateSha256=$Context.StateSha256
            ownerSha256=$Context.ColdOwnerSha256; filesReceiptSha256=$Context.ColdReceiptSha256
            intentSha256=$Context.ColdIntentSha256; historySha256=$Context.ColdHistorySha256
            runtime=$Context.Runtime
        }
        if (-not $Context.Runtime) {
            $observation['launch'] = $Context.ColdLaunch
            $observation['launchSha256'] = $Context.ColdLaunchSha256
        }
        if ($Context.PolicyRecovery) {
            $observation['step'] = $Context.PolicyStep
            $observation['claimed'] = $Context.PolicyClaimed
            $observation['policySequence'] = $Context.PolicySequence
            $observation['policySha256'] = $Context.PolicySha256
        }
        return $observation
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Cold activation observation refused.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Read-AgentsChatColdActivationRecoveryHistory {
    param([hashtable]$Proof, [string]$OwnerSha256, [string]$ReceiptSha256,
        [string]$IntentSha256, [string]$HistorySha256)
    $Control = $Proof.Control
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
    $first = $running = $runtime = $null
    $phases = @('start-requested')
    if ($proof.RecoveryFiles['recovery-lock'] -ccontains 'activation-running.json') {
        $phases += 'running'
    }
    if ($proof.RecoveryFiles['recovery-lock'] -ccontains 'activation-stopped.json') {
        if ($phases.Count -ne 2) { throw 'Stopped cold history requires its acknowledged runtime.' }
        $phases += 'stopped'
    }
    foreach ($phase in $phases) {
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
    if ($previous -cne $HistorySha256) { throw 'Original inactive cold history digest changed.' }
    $guarded = [xml]$first.definition.GetString()
    $namespaces = [Xml.XmlNamespaceManager]::new($guarded.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $commands = $guarded.SelectNodes('/t:Task/t:Actions/t:Exec/t:Command', $namespaces)
    if ($commands.Count -ne 1) { throw 'Cold activation history requires one original interpreter.' }
    $policy = @{
        Definition=$proof.Definition; Bundle=$proof.ColdRuntime.directory.GetString()
        Configuration=$proof.ColdRuntime.configuration.GetString()
        ConfigurationSha256=$proof.ColdRuntime.sha256.GetString(); Stage='cold-policy'
        PowerShell=$commands[0].InnerText
    }
    $expected = Get-AgentsChatColdActivationDefinition $policy `
        $first.controllerPid.GetInt32() $first.controllerIdentity.GetString()
    if (([xml]$record.definition.GetString()).OuterXml -cne $expected) {
        throw 'Stopped cold task is not its original literal guarded replacement.'
    }
    $proof.ActivationBridgePid = $first.controllerPid.GetInt32()
    $proof.ActivationBridgeIdentity = $first.controllerIdentity.GetString()
    $proof.Runtime = $runtime
    $proof.ColdPowerShell = $policy.PowerShell
    $proof.ColdDefinition = $record.definition.GetString()
    $proof.CurrentDefinition = $proof.ColdDefinition
    if (-not $runtime -and -not $proof.PolicyRecovery) {
        $actual = [string]$proof.Folder.GetTask($proof.TaskName).Xml
        if (-not (Test-AgentsChatColdRecoveryDefinition $proof.ColdDefinition $actual -Unacknowledged)) {
            throw 'Unacknowledged cold task differs from its original planned policy.'
        }
        $proof.CurrentDefinition = $actual
    }
    $proof.ColdOwnerSha256 = $OwnerSha256
    $proof.ColdReceiptSha256 = $ReceiptSha256
    $proof.ColdIntentSha256 = $IntentSha256
    $proof.ColdHistorySha256 = $HistorySha256
    $proof.ColdHistoryPhase = $phase
    $proof.ColdRunningRecord = $running
    if ($runtime) {
        Open-AgentsChatCompletionBundle $proof $proof.ColdRuntime.configuration.GetString() `
            $proof.ColdRuntime.sha256.GetString() $runtime
    } else {
        Open-AgentsChatColdLaunchProof $proof
    }
}

function Open-AgentsChatColdActivationRecoveryProof {
    param([string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256,
        [string]$IntentSha256, [string]$HistorySha256, [switch]$PolicyRecovery,
        [string]$PolicySha256, [int]$ControllerPid, [string]$ControllerIdentity)
    $proof = Open-AgentsChatStoppedRestoreEvidence -Control $Control -Recovery -ActivationHistory -PolicyRecovery:$PolicyRecovery
    try {
        Read-AgentsChatColdActivationRecoveryHistory $proof $OwnerSha256 $ReceiptSha256 $IntentSha256 $HistorySha256
        if ($PolicyRecovery) {
            $proof.PolicyControllerPid = $ControllerPid
            $proof.PolicyControllerIdentity = $ControllerIdentity
            $proof.PolicyBridgeIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            Read-AgentsChatColdPolicyHistory $proof $PolicySha256
        }
        Retain-AgentsChatColdRecoveryTaskFile $proof
        $null = Assert-AgentsChatColdActivationRecoveryProof $proof
        return $proof
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold observation and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
