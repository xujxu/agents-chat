. (Join-Path $PSScriptRoot 'windows-inactive-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-rollback-task.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-rollback-terminal.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-rollback-state.ps1')

function Publish-AgentsChatInactiveRollbackIntent([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ContainsKey('ExclusiveLostRuntime') -or -not $Context.ExclusiveLostRuntime) {
        throw 'Rollback intent requires original exclusive lost-runtime authority.'
    }
    if ($Context.ContainsKey('RollbackIntent')) {
        $Context.RollbackIntent.Check()
        return [pscustomobject]@{ file=(Join-Path $Context.Control 'inactive-rollback-intent.json'); sha256=$Context.RollbackIntent.Sha256 }
    }
    $manifest = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'backup/manifest.json') ''
    $prior = $Context.Completed.activatingState
    $document = [Text.Json.JsonDocument]::Parse($manifest.ReadText())
    try {
        $snapshot = $document.RootElement
        if ($snapshot.GetProperty('id').GetString() -cne $prior.GetProperty('backupId').GetString() -or
            $snapshot.GetProperty('project').GetString() -cne $Context.Project -or
            $snapshot.GetProperty('source').GetProperty('commit').GetString() -cne $prior.GetProperty('sourceCommit').GetString()) {
            throw 'Rollback manifest differs from original update source.'
        }
    } finally { $document.Dispose() }
    $record = [ordered]@{
        version=1; phase='rollback-requested'; operationId=$Context.OperationId
        stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
        backupId=$prior.GetProperty('backupId').GetString(); sourceCommit=$prior.GetProperty('sourceCommit').GetString()
        snapshotSha256=$manifest.Sha256; priorRuntime='stopped'; acceptDataLoss=$true
    }
    $text = $record | ConvertTo-Json -Compress
    $file = Join-Path $Context.Control 'inactive-rollback-intent.json'
    if (Test-Path -LiteralPath $file) {
        $intent = Open-AgentsChatCompletionFile $Context $file ''
        if ($intent.ReadText() -cne $text) { throw 'Original rollback intent differs from retained evidence.' }
    } else {
        $intent = [Deployment.WindowsPrivateFile]::Publish($file, $text)
        $Context.Files.Add($intent)
    }
    $Context.RollbackIntent = $intent
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$file; sha256=$intent.Sha256 }
}

function Publish-AgentsChatInactiveRollbackFilesReceipt([hashtable]$Context) {
    $intent = Publish-AgentsChatInactiveRollbackIntent $Context
    if ($Context.ContainsKey('RollbackFilesReceipt')) {
        $Context.RollbackFilesReceipt.Check()
        return [pscustomobject]@{ file=(Join-Path $Context.Control 'inactive-rollback-files-restored.json'); sha256=$Context.RollbackFilesReceipt.Sha256 }
    }
    $recorded = Read-AgentsChatMaintenanceFields ($Context.RollbackIntent.ReadText()) @(
        'version', 'phase', 'operationId', 'stateSha256', 'completionSha256',
        'backupId', 'sourceCommit', 'snapshotSha256', 'priorRuntime', 'acceptDataLoss')
    $directory = Join-Path $Context.Control 'inactive-rollback-runtime'
    $configuration = Join-Path $directory 'configuration.json'
    $sha256 = $Context.Admission.configurationSha256.GetString()
    Open-AgentsChatCompletionConfiguration $Context $configuration $sha256
    $record = [ordered]@{
        version=1; phase='files-restored'; operationId=$Context.OperationId
        stateSha256=$Context.StateSha256; intentSha256=$intent.sha256
        snapshotSha256=$recorded.snapshotSha256.GetString()
        sourceCommit=$recorded.sourceCommit.GetString(); priorRuntime='stopped'
        runtimeBundle=[ordered]@{ directory=$directory; configuration=$configuration; sha256=$sha256 }
    }
    $text = $record | ConvertTo-Json -Depth 4 -Compress
    $file = Join-Path $Context.Control 'inactive-rollback-files-restored.json'
    if (Test-Path -LiteralPath $file) {
        $receipt = Open-AgentsChatCompletionFile $Context $file ''
        if ($receipt.ReadText() -cne $text) { throw 'Rollback files receipt differs from retained original evidence.' }
    } else {
        $receipt = [Deployment.WindowsPrivateFile]::Publish($file, $text)
        $Context.Files.Add($receipt)
    }
    $Context.RollbackFilesReceipt = $receipt
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$file; sha256=$receipt.Sha256 }
}

function Open-AgentsChatInactiveLostRuntimeAuthority([string]$Control) {
    $context = Open-AgentsChatInactiveLostRuntimeEvidence $Control
    try {
        $original = $context.ReleaseIntentFile
        $identity = $original.CaptureIdentity()
        $sha256 = $original.Sha256
        $bytes = $original.ByteLength
        $original.Check()
        $original.Dispose()
        $null = $context.Files.Remove($original)
        $context.ReleaseIntentFile = [Deployment.WindowsPrivateFile]::OpenExclusive(
            (Join-Path $context.Directory 'inactive-complete-release-requested.json'),
            $sha256, $identity.Dev, $identity.Ino, $bytes)
        $context.Files.Add($context.ReleaseIntentFile)
        $context.ExclusiveLostRuntime = $true
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $context
        if (Test-Path -LiteralPath (Join-Path $Control 'inactive-rollback-intent.json')) {
            $null = Publish-AgentsChatInactiveRollbackIntent $context
        }
        if (Test-Path -LiteralPath (Join-Path $Control 'inactive-rollback-files-restored.json')) {
            $null = Publish-AgentsChatInactiveRollbackFilesReceipt $context
        }
        if (Test-Path -LiteralPath (Join-Path $Control 'inactive-rollback-terminal.json')) {
            $null = Publish-AgentsChatInactiveRollbackTerminal $context
        }
        if ((Test-Path -LiteralPath (Join-Path $Control 'inactive-rollback-state-intent.json')) -or
            (Test-Path -LiteralPath (Join-Path $Control 'state.json.lock'))) {
            $null = Stage-AgentsChatInactiveRollbackState $context -InspectOnly
        }
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch {
            throw [AggregateException]::new('Lost-runtime authority open and cleanup failed.',
                [Exception[]]@($failure, $_.Exception))
        }
        throw $failure
    }
}

function Assert-AgentsChatInactiveLostRuntimeState([hashtable]$Context) {
    Assert-AgentsChatInactiveCompletionHistory $Context
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) {
            throw 'Lost-runtime evidence conflicts with retirement.'
        }
    }
    foreach ($file in $Context.Files) { $file.Check() }
    Assert-AgentsChatInactiveRollbackPhysicalState $Context
    $runtime = $Context.Runtime
    Assert-AgentsChatCompletionProcessAbsent $runtime.pid $runtime.identity
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$runtime.generation, $runtime.sessionId)
    $task = $Context.Folder.GetTask($Context.TaskName)
    $actual = ([xml][string]$task.Xml).OuterXml
    $policyMatches = $actual -ceq ([xml]$Context.Completed.stagedDefinition.GetString()).OuterXml
    if ($Context.ContainsKey('RollbackTaskDefinition')) {
        $restored = $actual -ceq ([xml]$Context.RollbackTaskDefinition).OuterXml
        $policyMatches = $restored -or (-not $Context.RollbackTaskComplete -and $policyMatches)
    }
    if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
        -not $policyMatches -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Lost-runtime task differs from its original staged disabled policy.'
    }
}

function Assert-AgentsChatInactiveLostRuntimeEvidence([hashtable]$Context) {
    if (-not $Context.LostRuntime -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Inactive lost-runtime evidence is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatInactiveLostRuntimeState $Context
        Assert-AgentsChatInactiveLostRuntimeState $Context
        return [pscustomobject][ordered]@{
            status='inactive-runtime-lost'; mutationAuthority=$false; phase=$Context.Phase
            operationId=$Context.OperationId; taskName=$Context.TaskName; priorRuntime='stopped'
            stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
            runtime=[pscustomobject]$Context.Runtime
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Inactive lost-runtime evidence changed.', $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatInactiveLostRuntimeEvidence([string]$Control) {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null
        LostRuntime=$true; Stage='input'
    }
    try {
        if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
            $Control -cnotmatch '^[A-Za-z]:\\' -or $Control -match '[\x00\r\n]' -or
            $Control.Length -gt 4096 -or [IO.Path]::GetFullPath($Control) -cne $Control) {
            throw 'Lost-runtime evidence requires canonical Windows control.'
        }
        foreach ($directory in @($Control, (Join-Path $Control 'lock'), $context.Directory)) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        Read-AgentsChatInactiveCompletionRecords $context -ReleasedPrefix
        if ($context.Phase -cne 'release-requested') {
            throw 'Lost-runtime evidence requires the original unacknowledged release intent.'
        }
        Assert-AgentsChatInactiveCompletionHistory $context
        $runtime = ConvertFrom-AgentsChatCompletionRuntime $context.Completed.runtime.GetRawText()
        if ($runtime.generation -ceq $context.RetiredRuntime.generation -or
            $runtime.identity -ceq $context.RetiredRuntime.identity -or
            $runtime.configurationSha256 -cne $context.ConfigurationSha256) {
            throw 'Lost-runtime evidence does not identify its distinct new runtime.'
        }
        $context.Runtime = $runtime
        Open-AgentsChatCompletionBundle $context $context.Admission.configuration.GetString() `
            $context.Admission.configurationSha256.GetString() $context.RetiredRuntime
        Open-AgentsChatCompletionBundle $context $context.Configuration $context.ConfigurationSha256 $runtime
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $context.Folder = $scheduler.GetFolder('\')
        Open-AgentsChatInactiveRollbackTaskHistory $context
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch {
            throw [AggregateException]::new('Lost-runtime evidence open and cleanup failed.',
                [Exception[]]@($failure, $_.Exception))
        }
        throw $failure
    }
}
