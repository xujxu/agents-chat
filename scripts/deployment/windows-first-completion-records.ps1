. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-first-task-registration.ps1')
. (Join-Path $PSScriptRoot 'windows-first-deployment-identity.ps1')

function Read-AgentsChatFirstCompletionRecord(
    [hashtable]$Context, [string]$Name, [string[]]$Fields, [string[]]$OptionalFields = @()
) {
    $Context.Stage = "records-$Name"
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory "$Name.json") ''
    $Context.Hashes[$Name] = $file.Sha256
    if ($Name -ceq 'completion-release-requested') { $Context.ReleaseIntentFile = $file }
    $Context.CompletionText = $file.ReadText()
    if ($OptionalFields.Count) {
        $document = [Text.Json.JsonDocument]::Parse($Context.CompletionText)
        try {
            foreach ($optionalName in $OptionalFields) {
                $value = [Text.Json.JsonElement]::new()
                if ($document.RootElement.TryGetProperty($optionalName, [ref]$value)) { $Fields += $optionalName }
            }
        } finally { $document.Dispose() }
    }
    return Read-AgentsChatMaintenanceFields $Context.CompletionText $Fields
}

function Get-AgentsChatFirstCompletionRecordNames {
    return @('intent', 'registered', 'activation-prepared', 'activation-start-requested',
        'activation-running', 'completion-prepared', 'completion-policy-requested',
        'completion-policy-staged', 'completion-release-requested', 'completion-released',
        'completion-policy-restore-requested', 'completion-policy-restored',
        'completion-enable-requested', 'completion-complete')
}

function Read-AgentsChatFirstCompletionPrefix([hashtable]$Context) {
    $names = Get-AgentsChatFirstCompletionRecordNames
    $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $present.Add($entry.Name)) { throw 'Invalid first-completion prefix inventory.' }
    }
    $count = 0
    while ($count -lt $names.Count -and $present.Remove("$($names[$count]).json")) { $count++ }
    if ($present.Count -or $count -lt 9) { throw 'First-completion prefix has gaps or precedes release intent.' }
    $Context.RecordNames = $names[0..($count - 1)]
    $Context.DeploymentReceiptPresent = [IO.Directory]::GetFileSystemEntries($Context.Control, 'deployment.json').Length -ne 0
}

function Assert-AgentsChatFirstCompletionInventory([hashtable]$Context) {
    $Context.Stage = 'inventory'
    foreach ($name in @('recovery-lock', '.deployment.json.staging', 'task-maintenance', 'backup')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $name).Length) {
            throw 'First completion conflicts with existing deployment or recovery evidence.'
        }
        $hasReceipt = [IO.Directory]::GetFileSystemEntries($Context.Control, 'deployment.json').Length -ne 0
        if ($hasReceipt -ne $Context.DeploymentReceiptPresent -or
            ($hasReceipt -and $Context.RecordNames[-1] -cne 'completion-complete')) {
            throw 'First deployment receipt appeared, disappeared or precedes complete runtime handoff.'
        }
    }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Context.RecordNames) { $null = $expected.Add("$name.json") }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) { throw 'Unsupported first-completion inventory.' }
    }
    if ($expected.Count) { throw 'Incomplete first-completion inventory.' }
}

function Assert-AgentsChatFirstCompletionControllers([hashtable]$Context) {
    $Context.Stage = 'original-processes'
    Assert-AgentsChatCompletionProcessAbsent $Context.ActorPid $Context.ActorIdentity
    Assert-AgentsChatCompletionProcessAbsent $Context.BridgePid $Context.BridgeIdentity
}

function Read-AgentsChatFirstCompletionRecords([hashtable]$Context) {
    $Context.Stage = 'original-lock'
    $lockFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock/owner.json') ''
    $lock = Read-AgentsChatMaintenanceFields ($lockFile.ReadText()) @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    Assert-AgentsChatCompletionGuid $lock.token.GetString()
    Assert-AgentsChatCompletionGuid $lock.operationId.GetString()
    $Context.ActorPid = $lock.pid.GetInt32()
    $Context.ActorIdentity = $lock.processIdentity.GetString()
    if ($lock.version.GetInt32() -ne 1) { throw 'Unsupported first-completion lock.' }
    $Context.Stage = 'original-processes'
    Assert-AgentsChatCompletionProcessAbsent $Context.ActorPid $Context.ActorIdentity
    $Context.Project = $lock.project.GetString()
    $Context.OperationId = $lock.operationId.GetString()
    if ($Context.Project.Length -gt 4096 -or $Context.Project -cnotmatch '^[A-Za-z]:\\' -or
        $Context.Project -match '[\x00\r\n]' -or [IO.Path]::GetFullPath($Context.Project) -cne $Context.Project -or
        $Context.Control -cne (Join-Path (Split-Path -Parent $Context.Project) ".$(Split-Path -Leaf $Context.Project).deployment")) {
        throw 'First completion requires its original canonical project and sibling control.'
    }
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenSourceDirectory($Context.Project))
    $Context.Directory = Join-Path $Context.Control "first-task-$($Context.OperationId)"
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Context.Directory))
    Read-AgentsChatFirstCompletionPrefix $Context
    Assert-AgentsChatFirstCompletionInventory $Context
    $identity = @('project', 'operationId', 'taskName', 'controllerPid', 'controllerIdentity',
        'configuration', 'configurationSha256')
    $intent = Read-AgentsChatFirstCompletionRecord $Context 'intent' ($identity + @(
        'version', 'lockSha256', 'stateSha256', 'definition', 'permanentDefinition', 'accountSid', 'logonType', 'triggerType'))
    $Context.BridgePid = $intent.controllerPid.GetInt32()
    $Context.BridgeIdentity = $intent.controllerIdentity.GetString()
    Assert-AgentsChatFirstCompletionControllers $Context
    $Context.TaskName = $intent.taskName.GetString()
    $Context.AccountSid = $intent.accountSid.GetString()
    $Context.Configuration = $intent.configuration.GetString()
    $Context.ConfigurationSha256 = $intent.configurationSha256.GetString()
    $bundleDirectory = Join-Path $Context.Control "first-runtime-$($Context.OperationId)"
    if ($intent.version.GetInt32() -ne 1 -or $intent.lockSha256.GetString() -cne $lockFile.Sha256 -or
        $Context.BridgePid -eq $Context.ActorPid -or
        $Context.TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $Context.Configuration -cne (Join-Path $bundleDirectory 'configuration.json') -or
        $Context.ConfigurationSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $intent.stateSha256.GetString() -cnotmatch '^[a-f0-9]{64}$' -or
        $intent.logonType.GetString() -cnotin @('Interactive', 'S4U') -or
        $intent.triggerType.GetString() -cnotin @('AtLogOn', 'AtStartup')) { throw 'Original first-task intent differs.' }
    Assert-AgentsChatCompletionFields $intent $lock @('project', 'operationId')
    $registered = Read-AgentsChatFirstCompletionRecord $Context 'registered' ($identity + @(
        'status', 'runtimeAuthority', 'accountSid', 'logonType', 'triggerType', 'definition', 'permanentDefinition',
        'securityDescriptor', 'taskFileSha256', 'taskFileDev', 'taskFileIno', 'taskFileSecurityDescriptor'))
    Assert-AgentsChatCompletionFields $registered $intent ($identity + @('accountSid', 'logonType', 'triggerType', 'permanentDefinition'))
    $Context.SecurityDescriptor = $registered.securityDescriptor.GetString()
    if ($registered.status.GetString() -cne 'first-task-prepared' -or $registered.runtimeAuthority.GetBoolean() -or
        [string]::IsNullOrEmpty($Context.SecurityDescriptor) -or $Context.SecurityDescriptor.Length -gt 65536 -or
        $Context.SecurityDescriptor -match '[\x00\r\n]' -or
        $registered.taskFileSha256.GetString() -cnotmatch '^[a-f0-9]{64}$') { throw 'Original registration differs.' }
    Confirm-AgentsChatFirstTaskPolicy $intent.definition.GetString() $registered.definition.GetString() $Context.AccountSid
    $activationPrepared = Read-AgentsChatFirstCompletionRecord $Context 'activation-prepared' ($identity + @(
        'status', 'runtimeAuthority', 'lockSha256', 'configuringStateSha256', 'taskFileSha256'))
    Assert-AgentsChatCompletionFields $activationPrepared $intent ($identity + @('lockSha256'))
    Assert-AgentsChatCompletionFields $activationPrepared $registered @('taskFileSha256')
    if ($activationPrepared.status.GetString() -cne 'first-activation-prepared' -or
        $activationPrepared.runtimeAuthority.GetBoolean() -or
        $activationPrepared.configuringStateSha256.GetString() -cne $intent.stateSha256.GetString()) {
        throw 'Original first-activation handoff differs.'
    }
    $start = Read-AgentsChatFirstCompletionRecord $Context 'activation-start-requested' @(
        'version', 'operationId', 'taskName', 'controllerPid', 'controllerIdentity', 'stateSha256',
        'configuration', 'configurationSha256', 'definition', 'securityDescriptor')
    Assert-AgentsChatCompletionFields $start $registered @(
        'operationId', 'taskName', 'controllerPid', 'controllerIdentity', 'configuration', 'configurationSha256', 'securityDescriptor')
    if ($start.version.GetInt32() -ne 1 -or $start.stateSha256.GetString() -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Original first-runtime start differs.'
    }
    Confirm-AgentsChatFirstTaskPolicy $registered.definition.GetString() $start.definition.GetString() $Context.AccountSid
    $running = Read-AgentsChatFirstCompletionRecord $Context 'activation-running' @(
        'status', 'applicationHealthy', 'taskName', 'controllerPid', 'controllerIdentity', 'configurationSha256', 'runtime')
    Assert-AgentsChatCompletionFields $running $registered @('taskName', 'controllerPid', 'controllerIdentity', 'configurationSha256')
    if ($running.status.GetString() -cne 'first-runtime-running' -or $running.applicationHealthy.GetBoolean()) {
        throw 'Original first-runtime activation differs.'
    }
    $Context.Runtime = ConvertFrom-AgentsChatCompletionRuntime $running.runtime.GetRawText()
    if ($Context.Runtime.configurationSha256 -cne $Context.ConfigurationSha256 -or
        $Context.Runtime.pid -in @($Context.ActorPid, $Context.BridgePid)) { throw 'Ambiguous original runtime.' }
    $prepared = Read-AgentsChatFirstCompletionRecord $Context 'completion-prepared' ($identity + @(
        'status', 'runtimeAuthority', 'lockSha256', 'activatingStateSha256', 'generation', 'port', 'providers', 'listener')) @('deploymentIdentity')
    $Context.DeploymentIdentity = if ($prepared.ContainsKey('deploymentIdentity')) {
        Read-AgentsChatFirstDeploymentIdentity $prepared.deploymentIdentity.GetRawText()
    } else { $null }
    Assert-AgentsChatCompletionFields $prepared $intent ($identity + @('lockSha256'))
    if ($prepared.status.GetString() -cne 'first-completion-prepared' -or $prepared.runtimeAuthority.GetBoolean() -or
        $prepared.activatingStateSha256.GetString() -cne $start.stateSha256.GetString() -or
        $prepared.generation.GetString() -cne $Context.Runtime.generation) { throw 'Original completion handoff differs.' }
    $Context.Port = $prepared.port.GetInt32()
    $Context.Providers = [string[]]@($prepared.providers.EnumerateArray() | ForEach-Object { $_.GetString() })
    if ($Context.Port -lt 1 -or $Context.Port -gt 65535 -or $Context.Providers.Count -lt 1 -or $Context.Providers.Count -gt 3 -or
        @($Context.Providers | Select-Object -Unique).Count -ne $Context.Providers.Count -or
        @($Context.Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Unsupported first-completion readiness.'
    }
    $Context.ListenerRecord = Read-AgentsChatMaintenanceFields $prepared.listener.GetRawText() @(
        'status', 'generation', 'port', 'pid', 'identity', 'address', 'createdAt', 'pairedRecords')
    $listener = $Context.ListenerRecord
    if ($listener.status.GetString() -cne 'retained' -or $listener.generation.GetString() -cne $Context.Runtime.generation -or
        $listener.port.GetInt32() -ne $Context.Port) { throw 'Original first listener scope differs.' }
    Assert-AgentsChatCompletionProcessIdentity $listener.pid.GetInt32() $listener.identity.GetString()
    $permanentText = $intent.permanentDefinition.GetString()
    if ($permanentText.Length -gt 262144 -or $intent.definition.GetString().Length -gt 262144) {
        throw 'Oversized first-completion policy.'
    }
    $guarded = [xml]$permanentText
    $namespaces = [Xml.XmlNamespaceManager]::new($guarded.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $guarded.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText = 'false'
    $Context.PermanentDefinition = $permanentText
    $Context.PermanentDisabledDefinition = $guarded.OuterXml
    $guarded.SelectSingleNode('/t:Task/t:Triggers', $namespaces).IsEmpty = $true
    $restart = $guarded.SelectSingleNode('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
    $null = $restart.ParentNode.RemoveChild($restart)
    $arguments = $guarded.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces)
    $permanentArguments = $arguments.InnerText
    $arguments.InnerText += " -ControllerPid $($Context.BridgePid) -ControllerIdentity $($Context.BridgeIdentity)"
    Confirm-AgentsChatFirstTaskPolicy $guarded.OuterXml $registered.definition.GetString() $Context.AccountSid
    $arguments.InnerText = $permanentArguments
    $Context.StagedDefinition = $guarded.OuterXml
    $previous = $Context.Hashes['completion-prepared']
    $first = $null
    foreach ($name in $Context.RecordNames[6..($Context.RecordNames.Count - 1)]) {
        $phase = $name.Substring('completion-'.Length)
        $record = Read-AgentsChatFirstCompletionRecord $Context "completion-$phase" ($identity + @(
            'version', 'phase', 'status', 'lockSha256', 'activatingStateSha256', 'stateSha256',
            'runtime', 'definition', 'permanentDefinition', 'securityDescriptor', 'enabled', 'lease',
            'port', 'providers', 'listener', 'previousSha256'))
        Assert-AgentsChatCompletionFields $record $prepared ($identity + @(
            'lockSha256', 'activatingStateSha256', 'port', 'providers', 'listener'))
        Assert-AgentsChatCompletionFields $record $registered @('permanentDefinition', 'securityDescriptor')
        Assert-AgentsChatCompletionFields $record $running @('runtime')
        $complete = $phase -ceq 'complete'
        $guardedLease = $phase -cin @('policy-requested', 'policy-staged', 'release-requested')
        if ($record.version.GetInt32() -ne 1 -or $record.phase.GetString() -cne $phase -or
            $record.status.GetString() -cne $(if ($complete) { 'first-runtime-completed' } else { 'first-completion-progress' }) -or
            $record.enabled.GetBoolean() -ne $complete -or
            $record.lease.GetString() -cne $(if ($guardedLease) { 'guarded' } else { 'released' }) -or
            $record.previousSha256.GetString() -cne $previous -or
            $record.stateSha256.GetString() -cnotmatch '^[a-f0-9]{64}$') { throw 'Original first-completion chain differs.' }
        if ($null -eq $first) { $first = $record }
        else { Assert-AgentsChatCompletionFields $record $first @('stateSha256') }
        $expected = if ($phase -ceq 'policy-requested') { $registered.definition.GetString() }
            elseif ($complete) { $Context.PermanentDefinition }
            elseif ($phase -cin @('policy-restored', 'enable-requested')) { $Context.PermanentDisabledDefinition }
            else { $Context.StagedDefinition }
        Confirm-AgentsChatFirstTaskPolicy $expected $record.definition.GetString() $Context.AccountSid
        $previous = $Context.Hashes["completion-$phase"]
    }
    $Context.StateSha256 = $record.stateSha256.GetString()
    $Context.CompletionSha256 = $previous
    $Context.Phase = $record.phase.GetString()
    $state = Read-AgentsChatFirstAcceptedState $Context $lock
    $Context.AcceptedState = $state
    if ($null -ne $Context.DeploymentIdentity -and
        $Context.DeploymentIdentity.source -cne $state.targetCommit.GetString()) {
        throw 'Original first build identity differs from accepted source.'
    }
    if ($Context.DeploymentReceiptPresent) { Read-AgentsChatFirstDeploymentReceipt $Context $state }
}

function Read-AgentsChatFirstAcceptedState([hashtable]$Context, [hashtable]$Lock) {
    $Context.Stage = 'accepted-state'
    $stateFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $Context.StateSha256
    $state = Read-AgentsChatMaintenanceFields ($stateFile.ReadText()) @(
        'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase', 'sourceCommit',
        'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity', 'startedAt', 'updatedAt', 'errorCode')
    Assert-AgentsChatCompletionFields $state $lock @('project', 'operationId')
    $started = $updated = [DateTimeOffset]::MinValue
    if ($state.version.GetInt32() -ne 1 -or $state.operation.GetString() -cne 'deploy' -or
        $state.phase.GetString() -cne 'accepted' -or $state.previousPhase.GetString() -cne 'activating' -or
        $state.priorRuntime.GetString() -cne 'absent' -or $state.runtimeIdentity.GetString() -cne 'first-install-absent' -or
        $null -ne $state.backupId.GetString() -or $null -ne $state.errorCode.GetString() -or
        $state.startedAt.GetString() -cne $lock.createdAt.GetString() -or
        $state.targetCommit.GetString() -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' -or
        ($null -ne $state.sourceCommit.GetString() -and
            $state.sourceCommit.GetString() -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') -or
        -not [DateTimeOffset]::TryParseExact($state.startedAt.GetString(), "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$started) -or
        -not [DateTimeOffset]::TryParseExact($state.updatedAt.GetString(), "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$updated) -or
        $updated -lt $started) { throw 'Original accepted first-deployment state differs.' }
    return $state
}

function Read-AgentsChatFirstDeploymentReceipt([hashtable]$Context, [hashtable]$State) {
    $Context.Stage = 'deployment-receipt'
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'deployment.json') ''
    if ($file.ByteLength -gt 8192) { throw 'Oversized first deployment receipt.' }
    $receipt = Read-AgentsChatMaintenanceFields ($file.ReadText()) @(
        'version', 'project', 'operationId', 'status', 'acceptedAt', 'identity')
    Assert-AgentsChatCompletionFields $receipt $State @('project', 'operationId')
    $identity = Read-AgentsChatMaintenanceFields $receipt.identity.GetRawText() @(
        'source', 'build', 'dependencies', 'config', 'service')
    if ($receipt.version.GetInt32() -ne 1 -or $receipt.status.GetString() -cne 'accepted' -or
        $receipt.acceptedAt.GetString() -cne $State.updatedAt.GetString() -or
        $identity.source.GetString() -cne $State.targetCommit.GetString()) {
        throw 'First deployment receipt differs from original accepted state.'
    }
    foreach ($name in @('build', 'dependencies', 'config', 'service')) {
        if ($identity[$name].GetString() -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid first deployment identity digest.' }
    }
    if ($Context.ContainsKey('DeploymentIdentity') -and $null -ne $Context.DeploymentIdentity) {
        foreach ($name in @('source', 'build', 'dependencies', 'config')) {
            if ($identity[$name].GetString() -cne $Context.DeploymentIdentity[$name]) {
                throw 'First deployment receipt differs from original prepared identity.'
            }
        }
    }
    $Context.DeploymentReceiptFile = $file
}
