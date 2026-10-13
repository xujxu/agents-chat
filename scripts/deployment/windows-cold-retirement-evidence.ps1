. (Join-Path $PSScriptRoot 'windows-cold-retirement-record.ps1')
. (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')
. (Join-Path $PSScriptRoot 'windows-task-retirement-checkpoint.ps1')
. (Join-Path $PSScriptRoot 'windows-deployment-retirement-evidence.ps1')

function Read-AgentsChatColdRetirementAcceptance([hashtable]$Context, $Lock) {
    $Context.Stage = 'cold-retirement-acceptance'
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') ''
    if ($file.ByteLength -gt 65536) { throw 'Oversized cold terminal state.' }
    $state = Read-AgentsChatMaintenanceFields ($file.ReadText()) @(
        'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase', 'sourceCommit',
        'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity', 'startedAt', 'updatedAt', 'errorCode')
    if ($state.version.GetInt32() -ne 1 -or $state.project.GetString() -cne $Lock.project -or
        $state.operationId.GetString() -cne $Lock.operationId -or $state.operation.GetString() -cne 'restore' -or
        $state.phase.GetString() -cne 'restored' -or $state.previousPhase.GetString() -cne 'restore-activating' -or
        $null -ne $state.errorCode.GetString() -or $state.targetCommit.GetString() -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') {
        throw 'Cold retirement requires the original restored state.'
    }
    $receipt = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'deployment.json') ''
    if ($receipt.ByteLength -gt 8192) { throw 'Oversized cold deployment receipt.' }
    $record = Read-AgentsChatMaintenanceFields ($receipt.ReadText()) @(
        'version', 'project', 'operationId', 'status', 'acceptedAt', 'identity')
    Assert-AgentsChatCompletionFields $record $state @('project', 'operationId')
    $identity = Read-AgentsChatMaintenanceFields $record.identity.GetRawText() @('source', 'build', 'dependencies', 'config', 'service')
    if ($record.version.GetInt32() -ne 1 -or $record.status.GetString() -cne 'accepted' -or
        $record.acceptedAt.GetString() -cne $state.updatedAt.GetString() -or
        $identity.source.GetString() -cne $state.targetCommit.GetString()) { throw 'Cold retirement receipt differs from restored state.' }
    foreach ($name in @('build', 'dependencies', 'config', 'service')) {
        if ($identity[$name].GetString() -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid cold deployment identity.' }
    }
}

function New-AgentsChatColdRetirementCandidate([hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity) {
    $observed = Assert-AgentsChatColdCompletionProof $Context
    Assert-AgentsChatColdTerminalPhysicalState $Context
    if (-not $Context.TerminalPublished -or $Context.Phase -cne 'complete' -or $Context.Step -cne 'complete') {
        throw 'Cold retirement requires physically published restored state and completed runtime.'
    }
    $lockFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock\owner.json') ''
    $lock = Read-AgentsChatRetirementJson ($lockFile.ReadText())
    Read-AgentsChatColdRetirementAcceptance $Context $lock
    $manifest = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'worker-engine\manifest.json') ''
    $workerRecord = Read-AgentsChatRetirementJson ($manifest.ReadText())
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($relative in Get-AgentsChatColdRetirementPaths @($workerRecord.files | ForEach-Object { $_.name })) {
        if ($relative -cin @('task-maintenance', 'recovery-lock', 'worker-engine', 'lock')) {
            $entries.Add((Get-AgentsChatDeploymentRetirementDirectory $Context $relative))
        } elseif ($relative -ceq 'task-maintenance\transaction.json') {
            $entry = [ordered]@{ kind='file'; path=$relative }
            $descriptor = Get-AgentsChatColdTerminalFile $Context.CompletionAuthority
            foreach ($name in $descriptor.Keys) { $entry[$name] = $descriptor[$name] }
            $entries.Add($entry)
        } else { $entries.Add((Get-AgentsChatDeploymentRetirementFile $Context $relative)) }
    }
    $state = Get-AgentsChatRetirementFile $Context 'state.json'
    $completion = Get-AgentsChatRetirementCompletion $observed
    $completion.status = 'observed'
    $completion.mutationAuthority = $false
    $completion.stateSha256 = $state.sha256
    $last = $Context.CompletionRecord
    $candidate = [ordered]@{
        version=5; purpose='cold-restore'; control=$Context.Control; project=$Context.Project; lock=$lock
        controlIdentity=(Get-AgentsChatRetirementDirectory $Context $Context.Control)
        state=$state; receipt=(Get-AgentsChatRetirementFile $Context 'deployment.json')
        terminal=(Get-AgentsChatRetirementFile $Context 'cold-restore-terminal.json')
        completion=$completion
        checkpoint=[ordered]@{
            configuration=$Context.Configuration
            definitionSha256=(Get-AgentsChatRetirementTextHash $Context.NativeDefinition)
            securityDescriptorSha256=(Get-AgentsChatRetirementTextHash $Context.SecurityDescriptor)
            enabled=$Context.Enabled
            listener=[ordered]@{
                pid=$last.listenerPid.GetInt32(); processIdentity=$last.listenerIdentity.GetString()
                address=$last.listenerAddress.GetString(); createdAt=$last.listenerCreatedAt.GetString()
                pairedRecords=$last.listenerPairedRecords.GetBoolean()
            }
        }
        originals=[ordered]@{
            restoreController=[ordered]@{ pid=$lock.pid; processIdentity=$lock.processIdentity }
            stoppedRuntime=[ordered]@{ pid=$Context.Admission.ownerPid.GetInt32(); processIdentity=$Context.Admission.ownerIdentity.GetString() }
            coldController=[ordered]@{ pid=$Context.ColdControllerPid; processIdentity=$Context.ColdControllerIdentity }
            activationBridge=[ordered]@{ pid=$Context.ActivationBridgePid; processIdentity=$Context.ActivationBridgeIdentity }
        }
        workerManifestSha256=$manifest.Sha256; entries=$entries.ToArray()
        creator=[ordered]@{ pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID) }
    }
    $candidate = Read-AgentsChatRetirementJson ($candidate | ConvertTo-Json -Depth 16 -Compress)
    $validation = @{ Control=$Context.Control; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity }
    Initialize-AgentsChatColdRetirementRecord $validation $candidate
    $null = Assert-AgentsChatColdCompletionProof $Context
    $Context.ColdRetirementCandidate = $candidate
    return $candidate
}

function Publish-AgentsChatColdRetirementCandidate([hashtable]$Context) {
    if (-not $Context.ContainsKey('ColdRetirementCandidate') -or $Context.ContainsKey('ColdRetirementMarker')) {
        throw 'Cold retirement requires its original unpublished candidate.'
    }
    $null = Assert-AgentsChatColdCompletionProof $Context
    Assert-AgentsChatColdTerminalPhysicalState $Context
    if (-not $Context.TerminalPublished) { throw 'Cold terminal state changed before retirement.' }
    $marker = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control 'worker-retirement.json'),
        ($Context.ColdRetirementCandidate | ConvertTo-Json -Depth 16 -Compress))
    $Context.Files.Add($marker)
    $Context.ColdRetirementMarker = $marker
    $null = Assert-AgentsChatColdCompletionProof $Context
    return [ordered]@{ status='cold-retirement-prepared'; operationId=$Context.OperationId; sha256=$marker.Sha256 }
}
