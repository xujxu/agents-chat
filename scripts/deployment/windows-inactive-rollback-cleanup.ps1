. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-task-retirement-records.ps1')
. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-rollback-state.ps1')
. (Join-Path $PSScriptRoot 'windows-retirement-entries.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-rollback-workers.ps1')

function Assert-AgentsChatInactiveRollbackCleanupInventory([hashtable]$Context) {
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($index = $Context.Prefix; $index -lt $Context.Record.entries.Count; $index++) {
        $null = $expected.Add([IO.Path]::GetFileName($Context.Record.entries[$index].path))
    }
    foreach ($item in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($item.PSIsContainer -or -not $expected.Remove($item.Name)) {
            throw 'Unexpected stopped rollback retirement inventory.'
        }
    }
    if ($expected.Count) { throw 'Stopped rollback retirement is not a continuous deleted prefix.' }
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json',
        'recovery-lock', 'state.json.lock')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) {
            throw 'Stopped rollback cleanup conflicts with another recovery history.'
        }
    }
    if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock.pending-*').Length) {
        throw 'Stopped rollback cleanup conflicts with pending publication.'
    }
}

function Get-AgentsChatInactiveRollbackCleanupObservation([hashtable]$Context) {
    return [ordered]@{
        status='retiring'; operationId=$Context.OperationId
        stateSha256=$Context.Record.stateSha256; completionSha256=$Context.Record.completionSha256
        retiredEntries=$Context.Prefix; totalEntries=$Context.Record.entries.Count
    }
}

function Assert-AgentsChatStoppedRollbackRuntime([hashtable]$Context) {
    Assert-AgentsChatCompletionProcessAbsent $Context.Admission.controllerPid.GetInt32() $Context.Admission.controllerIdentity.GetString()
    Assert-AgentsChatCompletionProcessAbsent $Context.OriginalBridge.pid $Context.OriginalBridge.processIdentity
    foreach ($runtime in @($Context.Runtime, $Context.RetiredRuntime)) {
        Assert-AgentsChatCompletionProcessAbsent $runtime.pid $runtime.identity
        [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$runtime.generation, $runtime.sessionId)
    }
    if ($Context.ContainsKey('WorkerDomains')) {
        foreach ($domain in $Context.WorkerDomains) {
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$domain.generation, $domain.sessionId)
        }
    }
    $priorBundle = [IO.Path]::GetDirectoryName($Context.Admission.configuration.GetString())
    $runtimeFiles = @(Get-ChildItem -LiteralPath $priorBundle -Force |
        Where-Object Name -Match '^(runtime|launch)-.*\.json$')
    if ($runtimeFiles.Count -ne 1 -or $runtimeFiles[0].PSIsContainer -or
        $runtimeFiles[0].Name -cne "runtime-$($Context.RetiredRuntime.identity.Replace(':', '-')).json") {
        throw 'Stopped cleanup original runtime history changed.'
    }
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
        ([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Stopped cleanup lost original disabled task policy.'
    }
}

function Assert-AgentsChatInactiveRollbackCleanup([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Stopped cleanup authority is unavailable.' }
    $Context.Busy = $true
    try {
        foreach ($pass in @(1, 2)) {
            foreach ($file in $Context.Files) { $file.Check() }
            if ($Context.Target) { $Context.Target.Handle.Check() }
            Assert-AgentsChatInactiveRollbackCleanupInventory $Context
            Assert-AgentsChatStoppedRollbackRuntime $Context
        }
        return Get-AgentsChatInactiveRollbackCleanupObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Stopped rollback cleanup evidence changed.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Initialize-AgentsChatInactiveRollbackCleanup([hashtable]$Context) {
    $record = $Context.Record
    Assert-AgentsChatRetirementFields $record @('version', 'phase', 'control', 'project', 'operationId',
        'taskName', 'priorRuntime', 'restoredRuntime', 'stateSha256', 'completionSha256',
        'taskReceiptSha256', 'directory', 'entries', 'checkpoint')
    if ($record.version -isnot [int] -or $record.version -ne 2 -or
        $record.phase -cne 'task-retirement-prepared' -or $record.control -cne $Context.Control -or
        $record.priorRuntime -cne 'stopped' -or $record.restoredRuntime -cne 'stopped' -or
        $record.project -isnot [string] -or $record.project -cnotmatch '^[A-Za-z]:\\' -or
        $record.project.Length -gt 4096 -or $record.project -match '[\x00\r\n]' -or
        [IO.Path]::GetFullPath($record.project) -cne $record.project -or $record.project.Substring(3).Contains(':') -or
        [string]::Equals($record.project, $Context.Control, [StringComparison]::OrdinalIgnoreCase) -or
        $record.project.StartsWith($Context.Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Context.Control.StartsWith($record.project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $record.taskName -isnot [string] -or $record.taskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') {
        throw 'Invalid stopped retirement scope or unsupported intent version.'
    }
    Assert-AgentsChatCompletionGuid $record.operationId
    $Context.OperationId = $record.operationId
    $Context.Project = $record.project
    $Context.TaskName = $record.taskName
    $checkpoint = $record.checkpoint
    Assert-AgentsChatRetirementFields $checkpoint @('admission', 'bridge', 'runtime', 'retiredRuntime',
        'controlIdentity', 'lockIdentity', 'state', 'completion', 'taskReceipt', 'lock')
    Open-AgentsChatRetirementDirectory $Context $Context.Control $checkpoint.controlIdentity
    $workerMode = $Context.ContainsKey('WorkerMode') -and $Context.WorkerMode
    if (-not $workerMode) {
        Open-AgentsChatRetirementDirectory $Context $Context.Directory $record.directory
        Open-AgentsChatRetirementDirectory $Context (Join-Path $Context.Control 'lock') $checkpoint.lockIdentity
    }
    Assert-AgentsChatRetirementFields $checkpoint.bridge @('pid', 'processIdentity')
    if ($checkpoint.bridge.pid -isnot [int]) { throw 'Invalid stopped original bridge.' }
    Assert-AgentsChatCompletionProcessAbsent $checkpoint.bridge.pid $checkpoint.bridge.processIdentity
    $Context.OriginalBridge = $checkpoint.bridge
    $Context.Runtime = ConvertFrom-AgentsChatCompletionRuntime ($checkpoint.runtime | ConvertTo-Json -Compress)
    $Context.RetiredRuntime = ConvertFrom-AgentsChatRetiredRuntime ($checkpoint.retiredRuntime | ConvertTo-Json -Compress)
    if ($Context.Runtime.generation -ceq $Context.RetiredRuntime.generation -or
        $Context.Runtime.identity -ceq $Context.RetiredRuntime.identity) { throw 'Stopped runtimes are not distinct.' }
    if ($checkpoint.admission -isnot [string] -or
        [Text.Encoding]::UTF8.GetByteCount($checkpoint.admission) -gt 1048576) { throw 'Invalid stopped admission checkpoint.' }
    $admission = Read-AgentsChatMaintenanceFields $checkpoint.admission @(
        'version', 'kind', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition',
        'securityDescriptor', 'configuration', 'configurationSha256', 'retiredRuntime')
    if ($admission.version.GetInt32() -ne 2 -or $admission.kind.GetString() -cne 'inactive' -or
        $admission.operationId.GetString() -cne $record.operationId -or
        $admission.taskName.GetString() -cne $record.taskName -or
        $admission.controllerPid.GetInt32() -eq $checkpoint.bridge.pid -or
        $admission.definition.GetString().Length -gt 262144 -or
        $admission.securityDescriptor.GetString().Length -gt 65536 -or
        [string]::IsNullOrEmpty($admission.securityDescriptor.GetString()) -or
        $admission.securityDescriptor.GetString() -match '[\x00\r\n]' -or
        $admission.configurationSha256.GetString() -cne $Context.RetiredRuntime.configurationSha256 -or
        $Context.Runtime.configurationSha256 -cne $Context.RetiredRuntime.configurationSha256) {
        throw 'Stopped retirement admission differs from original operation.'
    }
    $old = ConvertFrom-AgentsChatRetiredRuntime $admission.retiredRuntime.GetRawText()
    foreach ($key in $old.Keys) {
        if ($old[$key] -cne $Context.RetiredRuntime[$key]) { throw 'Stopped retired runtime checkpoint differs.' }
    }
    $Context.Admission = $admission
    $Context.SecurityDescriptor = $admission.securityDescriptor.GetString()
    $state = Open-AgentsChatRetirementFile $Context $checkpoint.state 'state.json'
    $completion = Open-AgentsChatRetirementFile $Context $checkpoint.completion 'inactive-rollback-complete.json'
    $taskReceipt = Open-AgentsChatRetirementFile $Context $checkpoint.taskReceipt 'inactive-rollback-task-restored.json'
    $lockText = if ($workerMode) {
        Assert-AgentsChatRetirementDescriptor $checkpoint.lock 'lock\owner.json'
        if ($Context.StoredLockText -isnot [string] -or
            [Text.Encoding]::UTF8.GetByteCount($Context.StoredLockText) -ne $checkpoint.lock.bytes -or
            (Get-AgentsChatColdTerminalHash $Context.StoredLockText) -cne $checkpoint.lock.sha256) {
            throw 'Stopped worker cleanup durable lock differs.'
        }
        $Context.StoredLockText
    } else {
        $lockFile = Open-AgentsChatRetirementFile $Context $checkpoint.lock 'lock\owner.json'
        $lockFile.ReadText()
    }
    if ($record.stateSha256 -cne $state.Sha256 -or $record.completionSha256 -cne $completion.Sha256 -or
        $record.taskReceiptSha256 -cne $taskReceipt.Sha256) { throw 'Stopped cleanup receipt digest differs.' }
    $lock = Read-AgentsChatMaintenanceFields $lockText @(
        'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
    Assert-AgentsChatCompletionGuid $lock.token.GetString()
    if ($lock.version.GetInt32() -ne 1 -or $lock.operationId.GetString() -cne $Context.OperationId -or
        $lock.project.GetString() -cne $Context.Project -or
        $lock.pid.GetInt32() -ne $admission.controllerPid.GetInt32() -or
        $lock.processIdentity.GetString() -cne $admission.controllerIdentity.GetString()) {
        throw 'Stopped cleanup original lock differs.'
    }
    $receipt = Read-AgentsChatMaintenanceFields ($completion.ReadText()) @('version', 'phase', 'operationId',
        'stateSha256', 'priorRuntime', 'restoredRuntime', 'terminalSha256', 'stateIntentSha256', 'taskReceiptSha256')
    if ($receipt.version.GetInt32() -ne 1 -or $receipt.phase.GetString() -cne 'rollback-complete' -or
        $receipt.operationId.GetString() -cne $Context.OperationId -or
        $receipt.stateSha256.GetString() -cne $state.Sha256 -or
        $receipt.taskReceiptSha256.GetString() -cne $taskReceipt.Sha256 -or
        $receipt.priorRuntime.GetString() -cne 'stopped' -or $receipt.restoredRuntime.GetString() -cne 'stopped') {
        throw 'Stopped cleanup completion binding differs.'
    }
    $terminal = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'inactive-rollback-terminal.json') $receipt.terminalSha256.GetString()
    $handoff = Read-AgentsChatMaintenanceFields ($terminal.ReadText()) @(
        'version', 'phase', 'project', 'operationId', 'taskName', 'stateSha256', 'oldState', 'sourceCommit',
        'priorRuntime', 'restoredRuntime', 'rollbackIntentSha256', 'filesReceiptSha256',
        'taskIntentSha256', 'taskReceiptSha256', 'runtimeBundle', 'stateIdentity')
    if ($handoff.version.GetInt32() -ne 1 -or $handoff.phase.GetString() -cne 'terminal-prepared' -or
        $handoff.project.GetString() -cne $Context.Project -or $handoff.operationId.GetString() -cne $Context.OperationId -or
        $handoff.taskName.GetString() -cne $Context.TaskName -or
        $handoff.priorRuntime.GetString() -cne 'stopped' -or $handoff.restoredRuntime.GetString() -cne 'stopped' -or
        $handoff.taskReceiptSha256.GetString() -cne $taskReceipt.Sha256 -or
        (Get-AgentsChatColdTerminalHash $handoff.oldState.GetString()) -cne $handoff.stateSha256.GetString()) {
        throw 'Stopped cleanup original terminal handoff differs.'
    }
    $accepted = ConvertFrom-AgentsChatTaskTransactionState @{
        Project=$Context.Project; OperationId=$Context.OperationId
        Generation=$Context.RetiredRuntime.generation; StartedAt=$lock.createdAt.GetString()
    } $handoff.oldState.GetString() -InactiveCompletion
    if ($accepted.sourceCommit -cne $handoff.sourceCommit.GetString()) {
        throw 'Stopped cleanup original source differs.'
    }
    $stateIntent = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'inactive-rollback-state-intent.json') $receipt.stateIntentSha256.GetString()
    $proposal = Read-AgentsChatMaintenanceFields ($stateIntent.ReadText()) @(
        'version', 'phase', 'operationId', 'terminalSha256', 'oldState', 'nextState')
    $next = Read-AgentsChatMaintenanceFields ($state.ReadText()) @(
        'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase', 'sourceCommit',
        'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity', 'startedAt', 'updatedAt', 'errorCode')
    if ($proposal.version.GetInt32() -ne 1 -or $proposal.phase.GetString() -cne 'state-prepared' -or
        $proposal.operationId.GetString() -cne $Context.OperationId -or
        $proposal.terminalSha256.GetString() -cne $terminal.Sha256 -or
        $proposal.oldState.GetString() -cne $handoff.oldState.GetString() -or
        $proposal.nextState.GetString() -cne $state.ReadText() -or
        $next.operationId.GetString() -cne $Context.OperationId -or $next.project.GetString() -cne $Context.Project -or
        (Get-AgentsChatInactiveRollbackNextState $proposal.oldState.GetString() $next.updatedAt.GetString()) -cne $state.ReadText()) {
        throw 'Stopped cleanup terminal publication differs.'
    }
    $task = Read-AgentsChatMaintenanceFields ($taskReceipt.ReadText()) @(
        'version', 'phase', 'operationId', 'stateSha256', 'filesSha256', 'taskName', 'priorRuntime',
        'definition', 'securityDescriptor', 'runtimeBundle', 'intentSha256')
    $bundle = Join-Path $Context.Control 'inactive-rollback-runtime'
    $configuration = Join-Path $bundle 'configuration.json'
    $runtimeBundle = Read-AgentsChatMaintenanceFields $task.runtimeBundle.GetRawText() @('directory', 'configuration', 'sha256')
    $Context.Definition = New-AgentsChatTaskReplacementDefinition $admission.definition.GetString() `
        $configuration $admission.configurationSha256.GetString() $Context
    if ($task.version.GetInt32() -ne 1 -or $task.phase.GetString() -cne 'task-restored' -or
        $task.operationId.GetString() -cne $Context.OperationId -or $task.taskName.GetString() -cne $Context.TaskName -or
        $task.stateSha256.GetString() -cne $handoff.stateSha256.GetString() -or
        $task.filesSha256.GetString() -cne $handoff.filesReceiptSha256.GetString() -or
        $task.intentSha256.GetString() -cne $handoff.taskIntentSha256.GetString() -or
        $task.priorRuntime.GetString() -cne 'stopped' -or $task.definition.GetString() -cne $Context.Definition -or
        $task.securityDescriptor.GetString() -cne $Context.SecurityDescriptor -or
        $runtimeBundle.directory.GetString() -cne $bundle -or $runtimeBundle.configuration.GetString() -cne $configuration -or
        $runtimeBundle.sha256.GetString() -cne $admission.configurationSha256.GetString()) {
        throw 'Stopped cleanup restored task binding differs.'
    }
    foreach ($binding in @(
        @('inactive-rollback-intent.json', $handoff.rollbackIntentSha256.GetString()),
        @('inactive-rollback-files-restored.json', $handoff.filesReceiptSha256.GetString()),
        @('inactive-rollback-task-intent.json', $handoff.taskIntentSha256.GetString())
    )) {
        $null = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control $binding[0]) $binding[1]
    }
    Open-AgentsChatCompletionBundle $Context $admission.configuration.GetString() `
        $admission.configurationSha256.GetString() $Context.RetiredRuntime
    Open-AgentsChatCompletionBundle $Context `
        (Join-Path $Context.Control "runtime-$($Context.OperationId)\configuration.json") `
        $Context.Runtime.configurationSha256 $Context.Runtime
    Open-AgentsChatCompletionConfiguration $Context $configuration $admission.configurationSha256.GetString()
}

function Open-AgentsChatInactiveRollbackCleanup([string]$Control) {
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Folder=$null; Instance=$null
        Prefix=0; Target=$null
    }
    try {
        if ($Control -cnotmatch '^[A-Za-z]:\\' -or $Control.Length -gt 4096 -or
            $Control -match '[\x00\r\n]' -or [IO.Path]::GetFullPath($Control) -cne $Control) {
            throw 'Stopped cleanup requires canonical Windows control.'
        }
        $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($Control))
        if (Test-Path -LiteralPath (Join-Path $Control 'inactive-rollback-workers.json')) {
            throw 'Stopped task cleanup has handed off to durable worker retirement.'
        }
        $markerPath = Join-Path $Control 'inactive-rollback-retirement.json'
        $original = Open-AgentsChatCompletionFile $context $markerPath ''
        if ($original.ByteLength -gt 1048576) { throw 'Oversized stopped retirement checkpoint.' }
        $context.Record = Read-AgentsChatRetirementJson ($original.ReadText())
        $identity = $original.CaptureIdentity()
        $hash = $original.Sha256
        $bytes = $original.ByteLength
        $original.Dispose()
        $null = $context.Files.Remove($original)
        $context.Marker = [Deployment.WindowsPrivateFile]::OpenExclusive($markerPath, $hash, $identity.Dev, $identity.Ino, $bytes)
        $context.Files.Add($context.Marker)
        Initialize-AgentsChatInactiveRollbackCleanup $context
        $entries = $context.Record.entries
        $names = @('admission.json', 'inactive-activation-prepared.json') +
            @('replacement-requested', 'replacement-complete', 'start-requested', 'start-running',
                'complete-prepared', 'complete-policy-requested', 'complete-policy-staged', 'complete-release-requested' |
                ForEach-Object { "inactive-$_.json" })
        $sorted = [string[]]$names
        [Array]::Sort($sorted, [StringComparer]::Ordinal)
        if ($entries -isnot [array] -or $entries.Count -ne $sorted.Count) { throw 'Invalid stopped task history list.' }
        $context.Entries = [object[]]::new($entries.Count)
        $remaining = $false
        for ($index = 0; $index -lt $entries.Count; $index++) {
            $entry = $entries[$index]
            Assert-AgentsChatRetirementDescriptor $entry (Join-Path 'task-maintenance' $sorted[$index])
            if ($index -eq 0 -and ($entry.sha256 -cne (Get-AgentsChatColdTerminalHash $context.Record.checkpoint.admission) -or
                $entry.bytes -ne [Text.Encoding]::UTF8.GetByteCount($context.Record.checkpoint.admission))) {
                throw 'Stopped checkpoint admission differs from original descriptor.'
            }
            $file = Join-Path $Control $entry.path
            $entry.kind = 'file'
            if (-not (Test-Path -LiteralPath $file)) {
                if ($remaining) { throw 'Stopped cleanup history has a non-prefix gap.' }
                $context.Prefix++
                continue
            }
            $remaining = $true
            if ($sorted[$index] -ceq 'inactive-complete-release-requested.json') {
                $held = [Deployment.WindowsPrivateFile]::OpenExclusive($file, $entry.sha256, $entry.dev, $entry.ino, $entry.bytes)
                $context.Files.Add($held)
            } else {
                $held = Open-AgentsChatCompletionFile $context $file $entry.sha256
                $actual = $held.CaptureIdentity()
                if ($actual.Dev -cne $entry.dev -or $actual.Ino -cne $entry.ino -or $held.ByteLength -ne $entry.bytes) {
                    throw 'Stopped cleanup history identity changed.'
                }
            }
            $context.Entries[$index] = $held
        }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        $null = Assert-AgentsChatInactiveRollbackCleanup $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Stopped cleanup open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}

function Remove-AgentsChatNextInactiveRollbackEntry([hashtable]$Context) {
    if ($Context.Prefix -eq $Context.Record.entries.Count) {
        return Assert-AgentsChatInactiveRollbackCleanup $Context
    }
    return Remove-AgentsChatRetirementEntry $Context $null `
        { param($scope) Assert-AgentsChatInactiveRollbackCleanup $scope } `
        { throw 'Stopped cleanup must retain its durable checkpoint.' }
}
