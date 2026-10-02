. (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
. (Join-Path $PSScriptRoot 'windows-task-transaction.ps1')
. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')

function Open-AgentsChatCompletionFile([hashtable]$Context, [string]$Path, [string]$Sha256) {
    if ((Get-Item -LiteralPath $Path -Force).Length -gt 4194304) { throw 'Oversized completion evidence.' }
    if (-not $Sha256) { $Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    $file = [Deployment.WindowsPrivateFile]::Open($Path, $Sha256)
    $Context.Files.Add($file)
    return $file
}

function Assert-AgentsChatCompletionFields([hashtable]$Actual, [hashtable]$Expected, [string[]]$Names) {
    foreach ($name in $Names) {
        if ($Actual[$name].ValueKind -ne $Expected[$name].ValueKind) { throw "Completion field type differs: $name." }
        if ($name -cin @('definition', 'originalDefinition', 'replacementDefinition', 'enabledDefinition', 'stagedDefinition')) {
            if (([xml]$Actual[$name].GetString()).OuterXml -cne ([xml]$Expected[$name].GetString()).OuterXml) {
                throw "Completion task policy differs: $name."
            }
        } elseif ($Actual[$name].ValueKind -eq [Text.Json.JsonValueKind]::String) {
            if ($Actual[$name].GetString() -cne $Expected[$name].GetString()) { throw "Completion field differs: $name." }
        } elseif ($Actual[$name].GetRawText() -cne $Expected[$name].GetRawText()) {
            throw "Completion snapshot differs: $name."
        }
    }
}

function Assert-AgentsChatCompletionGuid([string]$Value) {
    if ([guid]$Value -eq [guid]::Empty -or ([guid]$Value).ToString('D') -cne $Value) {
        throw 'Invalid completion generation.'
    }
}

function Assert-AgentsChatCompletionProcessIdentity([int]$ProcessId, [string]$Identity) {
    if ($ProcessId -lt 1 -or $Identity.Length -gt 64 -or
        $Identity -cnotmatch "^$ProcessId`:[1-9][0-9]*$") { throw 'Invalid completion process identity.' }
}

function Read-AgentsChatTaskCompletionRecords([hashtable]$Context) {
    $Context.Stage = 'records-admission'
    $admitted = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory 'admission.json') ''
    $admission = Read-AgentsChatMaintenanceFields ($admitted.ReadText()) @(
        'version', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
        'securityDescriptor', 'configuration', 'configurationSha256', 'readySha256', 'ownerPid',
        'ownerIdentity', 'generation', 'instanceGuid')
    if ($admission.version.GetInt32() -ne 1) { throw 'Unsupported completion admission.' }
    foreach ($name in @('operationId', 'generation', 'instanceGuid')) {
        Assert-AgentsChatCompletionGuid $admission[$name].GetString()
    }
    Assert-AgentsChatCompletionProcessIdentity $admission.controllerPid.GetInt32() $admission.controllerIdentity.GetString()
    Assert-AgentsChatCompletionProcessIdentity $admission.ownerPid.GetInt32() $admission.ownerIdentity.GetString()
    if ($admission.controllerPid.GetInt32() -eq $admission.ownerPid.GetInt32()) { throw 'Ambiguous original controller.' }
    $Context.Admission = $admission
    $Context.OperationId = $admission.operationId.GetString()
    $Context.TaskName = $admission.taskName.GetString()
    $Context.SecurityDescriptor = $admission.securityDescriptor.GetString()
    if ($Context.TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        $admission.definition.GetString().Length -gt 262144 -or
        [string]::IsNullOrEmpty($Context.SecurityDescriptor) -or $Context.SecurityDescriptor.Length -gt 65536 -or
        $Context.SecurityDescriptor -match '[\x00\r\n]') { throw 'Unsupported completed task admission.' }

    $Context.Stage = 'records-transaction'
    $transactionFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory 'transaction.json') ''
    $transaction = Read-AgentsChatMaintenanceFields ($transactionFile.ReadText()) @(
        'version', 'operationId', 'project', 'controllerIdentity', 'admissionSha256', 'lockSha256',
        'initialStateSha256', 'initialState', 'priorRuntime', 'runtimeIdentity')
    if ($transaction.version.GetInt32() -ne 1 -or $transaction.admissionSha256.GetString() -cne $admitted.Sha256 -or
        $transaction.priorRuntime.GetString() -cne 'running' -or
        $transaction.runtimeIdentity.GetString() -cne $admission.generation.GetString()) {
        throw 'Original completion transaction differs.'
    }
    Assert-AgentsChatCompletionFields $transaction $admission @('operationId', 'controllerIdentity')
    $lockFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock/owner.json') $transaction.lockSha256.GetString()
    $lock = Read-AgentsChatMaintenanceFields ($lockFile.ReadText()) @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    Assert-AgentsChatCompletionGuid $lock.token.GetString()
    if ($lock.version.GetInt32() -ne 1 -or $lock.pid.GetInt32() -ne $admission.controllerPid.GetInt32() -or
        $lock.processIdentity.GetString() -cne $admission.controllerIdentity.GetString()) { throw 'Original completion lock differs.' }
    Assert-AgentsChatCompletionFields $lock $transaction @('project', 'operationId')
    $project = $lock.project.GetString()
    if ($project -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($project) -ine $project -or
        [string]::Equals($project, $Context.Control, [StringComparison]::OrdinalIgnoreCase) -or
        $Context.Control.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $project.StartsWith($Context.Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Completion control must remain external to its project.'
    }
    $scope = @{
        Project=$project; OperationId=$Context.OperationId; Generation=$admission.generation.GetString()
        StartedAt=$lock.createdAt.GetString()
    }
    $initialText = $transaction.initialState.GetString()
    $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($initialText)
    if ($bytes.Length -gt 65536) { throw 'Oversized initial completion state.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $initialHash = [Convert]::ToHexString($hash.ComputeHash($bytes)).ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($initialHash -cne $transaction.initialStateSha256.GetString()) { throw 'Initial completion state digest differs.' }
    $initial = ConvertFrom-AgentsChatTaskTransactionState $scope $initialText
    $restore = $initial.operation -ceq 'restore'
    if ($initial.phase -cne $(if ($restore) { 'restoring' } else { 'stopped' }) -or
        $initial.previousPhase -cne $(if ($restore) { 'restore-preflight' } else { 'preflight' })) {
        throw 'Initial completion state is not admitted for task stop.'
    }

    $common = @('version', 'phase', 'operationId', 'admissionSha256', 'previousSha256', 'transactionSha256', 'securityDescriptor')
    $schemas = @{
        stop=$common + @('instanceGuid', 'definition')
        retire=$common + @('taskName', 'definition', 'ownerPid', 'ownerIdentity', 'generation', 'instanceGuid', 'statePhase', 'stateSha256')
        replace=$common + @('stateSha256', 'taskName', 'originalDefinition', 'definition', 'configuration', 'configurationSha256')
        activate=$common + @('stateSha256', 'taskName', 'replacementDefinition', 'definition', 'enabledDefinition',
            'configuration', 'configurationSha256', 'leasePid', 'leaseIdentity', 'runtime')
        complete=$common + @('activatingStateSha256', 'activatingState', 'stateSha256', 'runtime', 'taskName',
            'definition', 'stagedDefinition', 'enabled', 'port', 'providers', 'listenerPid', 'listenerIdentity',
            'listenerCreatedAt', 'listenerAddress', 'listenerPairedRecords')
    }
    $Context.RecordNames = @('stop-intent', 'stop-inhibited', 'stop-stop-requested', 'stop-stopped',
        'retire-requested', 'retire-complete', 'replace-requested', 'replace-complete',
        'activate-requested', 'activate-prepared', 'activate-start-requested', 'activate-running',
        'complete-prepared', 'complete-policy-requested', 'complete-policy-staged', 'complete-release-requested',
        'complete-released', 'complete-policy-restore-requested', 'complete-policy-restored', 'complete-enable-requested', 'complete-complete')
    $records = @{}
    $previous = $admitted.Sha256
    foreach ($name in $Context.RecordNames) {
        $Context.Stage = "records-$name"
        $family, $phase = $name -csplit '-', 2
        $file = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Directory "task-$name.json") ''
        $record = Read-AgentsChatMaintenanceFields ($file.ReadText()) $schemas[$family]
        if ($record.version.GetInt32() -ne $(if ($family -ceq 'stop') { 2 } else { 1 }) -or
            $record.phase.GetString() -cne $phase -or $record.previousSha256.GetString() -cne $previous -or
            $record.admissionSha256.GetString() -cne $admitted.Sha256 -or
            $record.transactionSha256.GetString() -cne $transactionFile.Sha256) { throw 'Completion receipt chain differs.' }
        Assert-AgentsChatCompletionFields $record $admission @('operationId', 'securityDescriptor')
        if ($family -cne 'stop') { Assert-AgentsChatCompletionFields $record $admission @('taskName') }
        $records[$name] = $record
        $previous = $file.Sha256
    }
    $Context.CompletionSha256 = $previous
    $Context.Stage = 'records-policy-history'
    Assert-AgentsChatCompletionFields $records['stop-intent'] $admission @('definition')
    Confirm-AgentsChatTaskInhibition $admission.definition.GetString() $records['stop-inhibited'].definition.GetString()
    foreach ($name in @('stop-intent', 'stop-inhibited', 'stop-stop-requested', 'stop-stopped')) {
        Assert-AgentsChatCompletionFields $records[$name] $admission @('instanceGuid')
        if ($name -cne 'stop-intent') {
            Assert-AgentsChatCompletionFields $records[$name] $records['stop-inhibited'] @('definition')
        }
    }
    $prepared = $records['complete-prepared']
    $running = $records['activate-running']
    $replacement = $records['replace-complete']
    foreach ($name in @('retire-requested', 'retire-complete')) {
        $record = $records[$name]
        Assert-AgentsChatCompletionFields $record $records['stop-stopped'] @('definition')
        Assert-AgentsChatCompletionFields $record $admission @('ownerPid', 'ownerIdentity', 'generation', 'instanceGuid')
        if ($record.statePhase.GetString() -cne $(if ($restore) { 'restore-activating' } else { 'activating' }) -or
            $record.stateSha256.GetString() -cne $prepared.activatingStateSha256.GetString()) { throw 'Retirement state differs.' }
    }
    foreach ($name in @('replace-requested', 'replace-complete')) {
        $record = $records[$name]
        Assert-AgentsChatCompletionFields $record $replacement @('definition', 'configuration', 'configurationSha256')
        if (([xml]$record.originalDefinition.GetString()).OuterXml -cne
            ([xml]$records['stop-stopped'].definition.GetString()).OuterXml -or
            $record.stateSha256.GetString() -cne $prepared.activatingStateSha256.GetString()) { throw 'Replacement history differs.' }
    }
    Confirm-AgentsChatTaskReplacementPolicy $records['stop-stopped'].definition.GetString() $replacement.definition.GetString() $Context
    $Context.Configuration = $replacement.configuration.GetString()
    $Context.ConfigurationSha256 = $replacement.configurationSha256.GetString()
    $bundle = [IO.Path]::GetDirectoryName($Context.Configuration)
    if ([IO.Path]::GetFileName($Context.Configuration) -cne 'configuration.json' -or $Context.Configuration -match '%|\$\(' -or
        [string]::Equals($bundle, [IO.Path]::GetDirectoryName($admission.configuration.GetString()), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Completion replacement is not a distinct literal installed bundle.'
    }
    $permanent = [xml]$replacement.definition.GetString()
    $ns = [Xml.XmlNamespaceManager]::new($permanent.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $argumentsPath = '/t:Task/t:Actions/t:Exec/t:Arguments'
    $hostFile = Join-Path $bundle 'windows-runtime-host.ps1'
    $expectedArguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($Context.Configuration)`" -Sha256 $($Context.ConfigurationSha256)"
    if ($permanent.SelectSingleNode($argumentsPath, $ns).InnerText -cne $expectedArguments -or
        $permanent.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:WorkingDirectory', $ns).InnerText -cne $bundle -or
        $permanent.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command', $ns).InnerText -match '%|\$\(') {
        throw 'Completed action is not bound to the installed configuration.'
    }
    Assert-AgentsChatCompletionProcessIdentity $running.leasePid.GetInt32() $running.leaseIdentity.GetString()
    if ($running.leasePid.GetInt32() -eq $admission.controllerPid.GetInt32()) { throw 'Native bridge is not distinct.' }
    $staged = [xml]$permanent.OuterXml
    $triggers = $staged.SelectNodes('/t:Task/t:Triggers', $ns)
    $restart = $staged.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $ns)
    if ($triggers.Count -ne 1 -or $restart.Count -gt 1) { throw 'Ambiguous activation automation.' }
    $triggers[0].IsEmpty = $true
    if ($restart.Count) { $null = $restart[0].ParentNode.RemoveChild($restart[0]) }
    $guarded = [xml]$staged.OuterXml
    $guarded.SelectSingleNode($argumentsPath, $ns).InnerText +=
        " -ControllerPid $($running.leasePid.GetInt32()) -ControllerIdentity $($running.leaseIdentity.GetString())"
    $demand = [xml]$guarded.OuterXml
    $demand.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $ns).InnerText = 'true'
    foreach ($name in @('activate-requested', 'activate-prepared', 'activate-start-requested', 'activate-running')) {
        $record = $records[$name]
        Assert-AgentsChatCompletionFields $record $running @('leasePid', 'leaseIdentity')
        Assert-AgentsChatCompletionFields $record $replacement @('configuration', 'configurationSha256')
        if ($record.stateSha256.GetString() -cne $prepared.activatingStateSha256.GetString() -or
            ([xml]$record.replacementDefinition.GetString()).OuterXml -cne $permanent.OuterXml -or
            ([xml]$record.definition.GetString()).OuterXml -cne $guarded.OuterXml -or
            ([xml]$record.enabledDefinition.GetString()).OuterXml -cne $demand.OuterXml -or
            ($name -cne 'activate-running' -and $record.runtime.ValueKind -ne [Text.Json.JsonValueKind]::Null)) {
            throw 'Guarded activation history differs.'
        }
    }
    $Context.Stage = 'records-completion-state'
    $prior = ConvertFrom-AgentsChatTaskTransactionState $scope $prepared.activatingState.GetRawText()
    if ($prepared.activatingStateSha256.GetString() -cnotmatch '^[a-f0-9]{64}$' -or
        $prior.operation -cne $initial.operation -or
        $prior.phase -cne $(if ($restore) { 'restore-activating' } else { 'activating' }) -or
        $prior.previousPhase -cne $(if ($restore) { 'restoring' } else { 'configuring' }) -or
        [string]::CompareOrdinal($prior.updatedAt, $initial.updatedAt) -lt 0) { throw 'Original activating snapshot differs.' }
    $last = $records['complete-complete']
    $stateFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $last.stateSha256.GetString()
    if ((Get-Item -LiteralPath (Join-Path $Context.Control 'state.json')).Length -gt 65536) { throw 'Oversized completed state.' }
    $state = ConvertFrom-AgentsChatTaskTransactionState $scope ($stateFile.ReadText())
    if ($state.phase -cne $(if ($restore) { 'restored' } else { 'accepted' }) -or
        $state.previousPhase -cne $prior.phase -or [string]::CompareOrdinal($state.updatedAt, $prior.updatedAt) -lt 0) {
        throw 'Terminal state does not follow original activation.'
    }
    foreach ($key in $prior.Keys) {
        if ($key -cnotin @('phase', 'previousPhase', 'updatedAt') -and $state[$key] -cne $prior[$key]) {
            throw 'Terminal state changed original activation fields.'
        }
    }
    $original = [xml]$admission.definition.GetString()
    $enabled = $original.SelectNodes('/t:Task/t:Settings/t:Enabled', $ns)
    $Context.Enabled = $enabled.Count -eq 0 -or $enabled[0].InnerText -ceq 'true'
    foreach ($name in $Context.RecordNames | Where-Object { $_.StartsWith('complete-') }) {
        $record = $records[$name]
        Assert-AgentsChatCompletionFields $record $prepared @(
            'activatingStateSha256', 'activatingState', 'runtime', 'definition', 'stagedDefinition', 'enabled', 'port',
            'providers', 'listenerPid', 'listenerIdentity', 'listenerCreatedAt', 'listenerAddress', 'listenerPairedRecords')
        if (($name -ceq 'complete-prepared' -and $record.stateSha256.ValueKind -ne [Text.Json.JsonValueKind]::Null) -or
            ($name -cne 'complete-prepared' -and $record.stateSha256.GetString() -cne $stateFile.Sha256)) {
            throw 'Completion terminal digest differs.'
        }
    }
    Assert-AgentsChatCompletionFields $prepared $running @('runtime')
    if (([xml]$prepared.definition.GetString()).OuterXml -cne $permanent.OuterXml -or
        ([xml]$prepared.stagedDefinition.GetString()).OuterXml -cne $staged.OuterXml -or
        $prepared.enabled.GetBoolean() -ne $Context.Enabled) { throw 'Permanent completion policy differs.' }
    $Context.Project = $project
    $Context.StateSha256 = $stateFile.Sha256
    $Context.Definition = $replacement.definition.GetString()
    $Context.Completed = $last
    $Context.BridgePid = $running.leasePid.GetInt32()
    $Context.BridgeIdentity = $running.leaseIdentity.GetString()
}
