function Get-AgentsChatInactiveCompletionRecordNames {
    return @('replacement-requested', 'replacement-complete', 'start-requested', 'start-running',
        'complete-prepared', 'complete-policy-requested', 'complete-policy-staged', 'complete-release-requested',
        'complete-released', 'complete-policy-restore-requested', 'complete-complete')
}

function Read-AgentsChatInactiveCompletionRecords([hashtable]$Context, [switch]$ReleasedPrefix) {
    $Context.Stage = 'inactive-admission'
    $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory 'admission.json') ''
    $admission = Read-AgentsChatMaintenanceFields ($file.ReadText()) @(
        'version', 'kind', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
        'securityDescriptor', 'configuration', 'configurationSha256', 'retiredRuntime')
    if ($admission.version.GetInt32() -ne 2 -or $admission.kind.GetString() -cne 'inactive') {
        throw 'Independent inactive proof requires version-two inactive admission.'
    }
    Assert-AgentsChatCompletionGuid $admission.operationId.GetString()
    Assert-AgentsChatCompletionProcessIdentity $admission.controllerPid.GetInt32() $admission.controllerIdentity.GetString()
    $Context.Admission = $admission
    $Context.OperationId = $admission.operationId.GetString()
    $Context.TaskName = $admission.taskName.GetString()
    $Context.SecurityDescriptor = $admission.securityDescriptor.GetString()
    if ($Context.TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $admission.definition.GetString().Length -gt 262144 -or
        [string]::IsNullOrEmpty($Context.SecurityDescriptor) -or $Context.SecurityDescriptor.Length -gt 65536 -or
        $Context.SecurityDescriptor -match '[\x00\r\n]') { throw 'Unsupported inactive completion task.' }
    $Context.RetiredRuntime = ConvertFrom-AgentsChatRetiredRuntime $admission.retiredRuntime.GetRawText()
    $old = $Context.RetiredRuntime
    if ($old.configurationSha256 -cne $admission.configurationSha256.GetString()) { throw 'Invalid retired runtime.' }

    $Context.Stage = 'inactive-preparation'
    $preparedFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory 'inactive-activation-prepared.json') ''
    $activation = Read-AgentsChatMaintenanceFields ($preparedFile.ReadText()) @(
        'version', 'kind', 'phase', 'operationId', 'admissionSha256', 'stateSha256', 'sourceCommit',
        'targetCommit', 'backupId', 'taskName', 'definition', 'securityDescriptor', 'configuration', 'configurationSha256')
    if ($activation.version.GetInt32() -ne 1 -or $activation.kind.GetString() -cne 'inactive' -or
        $activation.phase.GetString() -cne 'activation-prepared' -or
        $activation.admissionSha256.GetString() -cne $file.Sha256 -or
        $activation.stateSha256.GetString() -cnotmatch '^[a-f0-9]{64}$') { throw 'Inactive preparation differs.' }
    Assert-AgentsChatCompletionFields $activation $admission @(
        'operationId', 'taskName', 'definition', 'securityDescriptor', 'configurationSha256')
    $common = @('version', 'kind', 'phase', 'operationId', 'preparationSha256', 'previousSha256',
        'stateSha256', 'taskName', 'definition', 'securityDescriptor')
    $schemas = @{
        replacement=$common + @('originalDefinition', 'configuration', 'configurationSha256')
        start=$common + @('controllerPid', 'controllerIdentity', 'configuration', 'configurationSha256', 'runtime')
        complete=$common + @('activatingStateSha256', 'activatingState', 'runtime', 'stagedDefinition',
            'enabled', 'port', 'providers', 'listenerPid', 'listenerIdentity', 'listenerCreatedAt',
            'listenerAddress', 'listenerPairedRecords')
    }
    $names = @(Get-AgentsChatInactiveCompletionRecordNames)
    if ($ReleasedPrefix) {
        $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
            if ($entry.PSIsContainer -or -not $present.Add($entry.Name)) { throw 'Invalid inactive prefix inventory.' }
        }
        if (-not $present.Remove('admission.json') -or -not $present.Remove('inactive-activation-prepared.json')) {
            throw 'Inactive prefix lacks its original admission or preparation.'
        }
        $count = 0
        while ($count -lt $names.Count -and $present.Remove("inactive-$($names[$count]).json")) { $count++ }
        if ($present.Count -or $count -lt 8) { throw 'Inactive prefix has gaps or precedes release intent.' }
        $names = $names[0..($count - 1)]
    }
    $Context.Inventory = @('admission.json', 'inactive-activation-prepared.json') +
        @($names | ForEach-Object { "inactive-$_.json" })
    $previous = $preparedFile.Sha256
    $records = @{}
    foreach ($name in $names) {
        $Context.Stage = "inactive-$name"
        $family, $phase = $name -csplit '-', 2
        $receipt = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory "inactive-$name.json") ''
        $record = Read-AgentsChatMaintenanceFields ($receipt.ReadText()) $schemas[$family]
        $expectedPhase = if ($family -ceq 'replacement') { $name } else { $phase }
        if ($record.version.GetInt32() -ne 1 -or $record.kind.GetString() -cne 'inactive' -or
            $record.phase.GetString() -cne $expectedPhase -or
            $record.preparationSha256.GetString() -cne $preparedFile.Sha256 -or
            $record.previousSha256.GetString() -cne $previous) { throw 'Inactive completion chain differs.' }
        Assert-AgentsChatCompletionFields $record $admission @('operationId', 'taskName', 'securityDescriptor')
        if ($family -cne 'complete') {
            Assert-AgentsChatCompletionFields $record $activation @('stateSha256', 'configuration', 'configurationSha256')
        }
        $records[$name] = $record
        $previous = $receipt.Sha256
        if ($name -ceq 'complete-release-requested') { $Context.ReleaseIntentFile = $receipt }
    }
    $Context.CompletionText = $receipt.ReadText()
    $Context.CompletionSha256 = $previous
    $replacement = $records['replacement-complete']
    $running = $records['start-running']
    $prepared = $records['complete-prepared']
    $completed = $records[$names[-1]]
    $Context.Phase = $completed.phase.GetString()
    $Context.Configuration = $activation.configuration.GetString()
    $Context.ConfigurationSha256 = $activation.configurationSha256.GetString()
    $expectedConfiguration = Join-Path (Join-Path $Context.Control "runtime-$($Context.OperationId)") 'configuration.json'
    if ($Context.Configuration -cne $expectedConfiguration -or $Context.Configuration -match '%|\$\(' -or
        [string]::Equals($Context.Configuration, $admission.configuration.GetString(), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Inactive completion requires its distinct literal operation bundle.'
    }
    $originalDefinition = $admission.definition.GetString()
    $expectedDefinition = New-AgentsChatTaskReplacementDefinition $originalDefinition `
        $Context.Configuration $Context.ConfigurationSha256 $Context
    foreach ($name in @('replacement-requested', 'replacement-complete')) {
        $record = $records[$name]
        if (([xml]$record.originalDefinition.GetString()).OuterXml -cne ([xml]$originalDefinition).OuterXml -or
            ([xml]$record.definition.GetString()).OuterXml -cne ([xml]$expectedDefinition).OuterXml) {
            throw 'Inactive replacement policy history differs.'
        }
    }
    $Context.BridgePid = $running.controllerPid.GetInt32()
    $Context.BridgeIdentity = $running.controllerIdentity.GetString()
    Assert-AgentsChatCompletionProcessIdentity $Context.BridgePid $Context.BridgeIdentity
    if ($Context.BridgePid -eq $admission.controllerPid.GetInt32()) { throw 'Inactive bridge is not distinct.' }
    $guarded = Get-AgentsChatGuardedActivationDefinition @{
        Definition=$replacement.definition.GetString(); Configuration=$Context.Configuration
        ConfigurationSha256=$Context.ConfigurationSha256; Bundle=[IO.Path]::GetDirectoryName($Context.Configuration)
    } $Context.BridgePid $Context.BridgeIdentity
    foreach ($name in @('start-requested', 'start-running')) {
        Assert-AgentsChatCompletionFields $records[$name] $running @('controllerPid', 'controllerIdentity')
        if (([xml]$records[$name].definition.GetString()).OuterXml -cne ([xml]$guarded).OuterXml) {
            throw 'Inactive guarded startup policy differs.'
        }
    }
    if ($records['start-requested'].runtime.ValueKind -ne [Text.Json.JsonValueKind]::Null) {
        throw 'Inactive startup intent invented a runtime.'
    }
    $staged = [xml]$guarded
    $ns = [Xml.XmlNamespaceManager]::new($staged.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $arguments = '/t:Task/t:Actions/t:Exec/t:Arguments'
    $staged.SelectSingleNode($arguments, $ns).InnerText = ([xml]$expectedDefinition).SelectSingleNode($arguments, $ns).InnerText
    if (([xml]$prepared.definition.GetString()).OuterXml -cne ([xml]$expectedDefinition).OuterXml -or
        ([xml]$prepared.stagedDefinition.GetString()).OuterXml -cne $staged.OuterXml -or
        $prepared.enabled.GetBoolean()) { throw 'Inactive completion permanent policy differs.' }
    Assert-AgentsChatCompletionFields $prepared $running @('runtime')
    $Context.Stage = 'inactive-lock-state'
    $lockFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock/owner.json') ''
    $lock = Read-AgentsChatMaintenanceFields ($lockFile.ReadText()) @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    Assert-AgentsChatCompletionGuid $lock.token.GetString()
    if ($lock.version.GetInt32() -ne 1 -or $lock.operationId.GetString() -cne $Context.OperationId -or
        $lock.pid.GetInt32() -ne $admission.controllerPid.GetInt32() -or
        $lock.processIdentity.GetString() -cne $admission.controllerIdentity.GetString()) { throw 'Inactive completion lock differs.' }
    $Context.Project = $lock.project.GetString()
    if ($Context.Project -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Context.Project) -cne $Context.Project -or
        [string]::Equals($Context.Project, $Context.Control, [StringComparison]::OrdinalIgnoreCase) -or
        $Context.Project.StartsWith($Context.Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Context.Control.StartsWith($Context.Project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Inactive completion project is not external to control.'
    }
    $scope = @{ Project=$Context.Project; OperationId=$Context.OperationId; Generation=$old.generation; StartedAt=$lock.createdAt.GetString() }
    $prior = ConvertFrom-AgentsChatTaskTransactionState $scope $prepared.activatingState.GetRawText() -InactiveActivation
    foreach ($name in @('sourceCommit', 'targetCommit', 'backupId')) {
        if ($prior[$name] -cne $activation[$name].GetString()) { throw 'Inactive activation source differs.' }
    }
    if ($prepared.activatingStateSha256.GetString() -cne $activation.stateSha256.GetString()) {
        throw 'Inactive activating digest differs.'
    }
    $statePath = Join-Path $Context.Control 'state.json'
    if ((Get-Item -LiteralPath $statePath -Force).Length -gt 65536) { throw 'Oversized inactive accepted state.' }
    $stateFile = Open-AgentsChatCompletionFile $Context $statePath $completed.stateSha256.GetString()
    $state = ConvertFrom-AgentsChatTaskTransactionState $scope ($stateFile.ReadText()) -InactiveCompletion
    if ([string]::CompareOrdinal($state.updatedAt, $prior.updatedAt) -lt 0) { throw 'Inactive accepted state predates activation.' }
    foreach ($key in $prior.Keys) {
        if ($key -cnotin @('phase', 'previousPhase', 'updatedAt') -and $state[$key] -cne $prior[$key]) {
            throw 'Inactive accepted state changed original fields.'
        }
    }
    foreach ($name in $names | Where-Object { $_.StartsWith('complete-') }) {
        $record = $records[$name]
        Assert-AgentsChatCompletionFields $record $prepared @(
            'activatingStateSha256', 'activatingState', 'runtime', 'definition', 'stagedDefinition', 'enabled',
            'port', 'providers', 'listenerPid', 'listenerIdentity', 'listenerCreatedAt', 'listenerAddress', 'listenerPairedRecords')
        if (($name -ceq 'complete-prepared' -and $record.stateSha256.ValueKind -ne [Text.Json.JsonValueKind]::Null) -or
            ($name -cne 'complete-prepared' -and $record.stateSha256.GetString() -cne $stateFile.Sha256)) {
            throw 'Inactive accepted state digest differs.'
        }
    }
    $Context.StateSha256 = $stateFile.Sha256
    $Context.Definition = $replacement.definition.GetString()
    $Context.Enabled = $false
    $Context.Completed = $completed
}
