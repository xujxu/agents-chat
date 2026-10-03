. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')

function Read-AgentsChatCompletionPrefix([hashtable]$Context) {
    $names = @(Get-AgentsChatCompletionRecordNames)
    $present = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $present.Add($entry.Name)) { throw 'Invalid completion prefix inventory.' }
    }
    if (-not $present.Remove('admission.json') -or -not $present.Remove('transaction.json')) {
        throw 'Completion prefix lacks admission or transaction.'
    }
    $count = 0
    while ($count -lt $names.Count -and $present.Remove("task-$($names[$count]).json")) { $count++ }
    if ($present.Count -or $count -lt 16) { throw 'Completion prefix has gaps or precedes release intent.' }
    Read-AgentsChatTaskCompletionHistory $Context $names[0..($count - 1)]
    $Context.Phase = $Context.CompletionRecord.phase.GetString()
}

function Resolve-AgentsChatCompletionRecoveryPolicy([hashtable]$Context) {
    $Context.TargetEnabled = $Context.Enabled
    $actual = ([xml]$Context.NativeDefinition).OuterXml
    $staged = ([xml]$Context.CompletionRecord.stagedDefinition.GetString()).OuterXml
    $permanent = ([xml]$Context.Definition).OuterXml
    $isStaged = -not $Context.NativeEnabled -and $actual -ceq $staged
    $isPermanentDisabled = -not $Context.NativeEnabled -and $actual -ceq $permanent
    $Context.Step = $Context.Phase
    switch -CaseSensitive ($Context.Phase) {
        { $_ -cin @('release-requested', 'released') } {
            if (-not $isStaged) { throw 'Release prefix requires original staged disabled policy.' }
        }
        'policy-restore-requested' {
            if ($isPermanentDisabled) { $Context.Step = 'permanent-policy-applied' }
            elseif (-not $isStaged) { throw 'Pending permanent policy is not a recognized native state.' }
        }
        'policy-restored' {
            if (-not $isPermanentDisabled) { throw 'Acknowledged permanent disabled policy differs.' }
        }
        { $_ -cin @('enable-requested', 'complete') } {
            if ($Context.NativeEnabled) {
                if (-not $Context.TargetEnabled) { throw 'Originally disabled task became enabled.' }
                Confirm-AgentsChatTaskInhibition $Context.NativeDefinition $Context.Definition
            } elseif (-not $isPermanentDisabled) { throw 'Pending enabled policy differs.' }
            if ($Context.Phase -ceq 'complete') {
                if ($Context.NativeEnabled -ne $Context.TargetEnabled) { throw 'Completed enabled value differs.' }
            } elseif ($Context.NativeEnabled -eq $Context.TargetEnabled) { $Context.Step = 'enable-applied' }
        }
        default { throw 'Unsupported completion recovery prefix.' }
    }
    $Context.Enabled = $Context.NativeEnabled
}

function Assert-AgentsChatCompletionRecoveryEvidence([hashtable]$Context) {
    $Context.Stage = 'recovery-retirement-conflict'
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) { throw 'Retirement evidence requires its original consumer.' }
    }
    Assert-AgentsChatCompletionInventory $Context
    Assert-AgentsChatCompletionControllers $Context
    $Context.Stage = 'retained-evidence'
    foreach ($file in $Context.Files) { $file.Check() }
    Assert-AgentsChatCompletionRuntime $Context
    foreach ($file in $Context.Files) { $file.Check() }
    Assert-AgentsChatCompletionInventory $Context
    Assert-AgentsChatCompletionControllers $Context
    Assert-AgentsChatCompletionFinalRuntime $Context
}

function Get-AgentsChatCompletionRecoveryObservation([hashtable]$Context) {
    return [pscustomobject][ordered]@{
        status=$(if ($Context.Phase -ceq 'complete') { 'complete' } else { 'pending' })
        phase=$Context.Phase; step=$Context.Step
        operationId=$Context.OperationId; taskName=$Context.TaskName
        stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
        runtime=[pscustomobject]$Context.Runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
    }
}

function Assert-AgentsChatTaskCompletionRecovery([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Completion recovery is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatCompletionRecoveryEvidence $Context
        return Get-AgentsChatCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Completion recovery refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Write-AgentsChatRecoveredCompletionReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'recovery-receipt'
    $document = [Text.Json.JsonDocument]::Parse($Context.CompletionText)
    try {
        $properties = [Collections.Generic.List[string]]::new()
        foreach ($property in $document.RootElement.EnumerateObject()) {
            $value = switch -CaseSensitive ($property.Name) {
                'phase' { '"' + $Phase + '"' }
                'previousSha256' { '"' + $Context.CompletionSha256 + '"' }
                default { $property.Value.GetRawText() }
            }
            # Preserve nested snapshots exactly, including strings that resemble dates.
            $properties.Add('"' + $property.Name + '":' + $value)
        }
        $text = '{' + ($properties -join ',') + '}'
    } finally { $document.Dispose() }
    $file = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory "task-complete-$Phase.json"), $text)
    $Context.Files.Add($file)
    $Context.RecordNames += "complete-$Phase"
    $Context.CompletionText = $text
    $Context.CompletionSha256 = $file.Sha256
    $Context.Phase = $Phase
    $Context.Step = $Phase
}

function Advance-AgentsChatTaskCompletionRecovery([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Completion recovery is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatCompletionRecoveryEvidence $Context
        switch -CaseSensitive ($Context.Step) {
            'release-requested' { Write-AgentsChatRecoveredCompletionReceipt $Context 'released' }
            'released' { Write-AgentsChatRecoveredCompletionReceipt $Context 'policy-restore-requested' }
            'policy-restore-requested' {
                $Context.Stage = 'recovery-registration'
                $task = $Context.Folder.GetTask($Context.TaskName)
                $principal = $task.Definition.Principal
                $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.Definition, (4 -bor 16 -bor 32),
                    [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
                $task = $Context.Folder.GetTask($Context.TaskName)
                if ($task.Enabled -or ([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml -or
                    [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                    throw 'Recovered permanent disabled policy differs.'
                }
                $Context.NativeDefinition = [string]$task.Xml
                $Context.Step = 'permanent-policy-applied'
            }
            'permanent-policy-applied' { Write-AgentsChatRecoveredCompletionReceipt $Context 'policy-restored' }
            'policy-restored' { Write-AgentsChatRecoveredCompletionReceipt $Context 'enable-requested' }
            'enable-requested' {
                $Context.Stage = 'recovery-enable'
                $task = $Context.Folder.GetTask($Context.TaskName)
                $task.Enabled = $Context.TargetEnabled
                $task = $Context.Folder.GetTask($Context.TaskName)
                if ([bool]$task.Enabled -ne $Context.TargetEnabled -or
                    [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                    throw 'Recovered enabled value or security differs.'
                }
                if ($Context.TargetEnabled) { Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $Context.Definition }
                elseif (([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml) {
                    throw 'Recovered disabled policy differs.'
                }
                $Context.NativeDefinition = [string]$task.Xml
                $Context.Enabled = $Context.TargetEnabled
                $Context.Step = 'enable-applied'
            }
            'enable-applied' { Write-AgentsChatRecoveredCompletionReceipt $Context 'complete' }
            'complete' { }
            default { throw 'Unsupported completion recovery step.' }
        }
        Assert-AgentsChatCompletionRecoveryEvidence $Context
        return Get-AgentsChatCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Completion recovery refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatTaskCompletionRecovery([string]$Control) {
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='directories'
    }
    try {
        if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported completion recovery platform.' }
        foreach ($directory in @($Control, (Join-Path $Control 'lock'), $context.Directory)) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        $context.Stage = 'prefix'
        Read-AgentsChatCompletionPrefix $context
        Assert-AgentsChatCompletionInventory $context
        Assert-AgentsChatCompletionControllers $context
        $context.Stage = 'recovery-exclusive-evidence'
        $original = $context.ReleaseIntentFile
        $identity = $original.CaptureIdentity()
        $sha256 = $original.Sha256
        $bytes = $original.ByteLength
        $original.Dispose()
        $null = $context.Files.Remove($original)
        # Keep a dying recovery bridge exclusive even after its Node admission owner exits.
        $context.ReleaseIntentFile = [Deployment.WindowsPrivateFile]::OpenExclusive(
            (Join-Path $context.Directory 'task-complete-release-requested.json'),
            $sha256, $identity.Dev, $identity.Ino, $bytes)
        $context.Files.Add($context.ReleaseIntentFile)
        Initialize-AgentsChatCompletionRuntime $context $context.CompletionRecord
        $context.Stage = 'recovery-policy'
        Resolve-AgentsChatCompletionRecoveryPolicy $context
        $null = Assert-AgentsChatTaskCompletionRecovery $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Completion recovery open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Completion recovery open and close failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
