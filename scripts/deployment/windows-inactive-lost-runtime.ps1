. (Join-Path $PSScriptRoot 'windows-inactive-completion-proof.ps1')

function Assert-AgentsChatInactiveLostRuntimeState([hashtable]$Context) {
    Assert-AgentsChatInactiveCompletionHistory $Context
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) {
            throw 'Lost-runtime evidence conflicts with retirement.'
        }
    }
    foreach ($file in $Context.Files) { $file.Check() }
    $runtime = $Context.Runtime
    Assert-AgentsChatCompletionProcessAbsent $runtime.pid $runtime.identity
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$runtime.generation, $runtime.sessionId)
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
        ([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.Completed.stagedDefinition.GetString()).OuterXml -or
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
