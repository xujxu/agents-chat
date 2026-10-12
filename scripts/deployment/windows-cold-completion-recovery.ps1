. (Join-Path $PSScriptRoot 'windows-cold-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-task-completion-recovery.ps1')

function Retain-AgentsChatColdCompletionAuthority([hashtable]$Context) {
    $path = Join-Path $Context.Directory 'transaction.json'
    $original = Open-AgentsChatCompletionFile $Context $path ''
    $identity = $original.CaptureIdentity()
    $sha256 = $original.Sha256
    $bytes = $original.ByteLength
    for ($index = $Context.Files.Count - 1; $index -ge 0; $index--) {
        $file = $Context.Files[$index]
        if ($file -isnot [Deployment.WindowsPrivateFile]) { continue }
        $candidate = $file.CaptureIdentity()
        if ($candidate.Dev -ceq $identity.Dev -and $candidate.Ino -ceq $identity.Ino) {
            $file.Dispose()
            $Context.Files.RemoveAt($index)
        }
    }
    # This immutable original transaction stays exclusive after the Node owner exits.
    $Context.Files.Add([Deployment.WindowsPrivateFile]::OpenExclusive(
        $path, $sha256, $identity.Dev, $identity.Ino, $bytes))
}

function Write-AgentsChatRecoveredColdCompletion([hashtable]$Context, [string]$Phase) {
    $properties = [Collections.Generic.List[string]]::new()
    foreach ($name in $Context.CompletionSchema) {
        $value = switch -CaseSensitive ($name) {
            'phase' { '"' + $Phase + '"' }
            'previousSha256' { '"' + $Context.CompletionSha256 + '"' }
            'definition' { ConvertTo-Json -InputObject $Context.NativeDefinition -Compress }
            'enabled' { if ($Context.Enabled) { 'true' } else { 'false' } }
            'lease' { '"released"' }
            default { $Context.CompletionRecord[$name].GetRawText() }
        }
        $properties.Add('"' + $name + '":' + $value)
    }
    $text = '{' + ($properties -join ',') + '}'
    $name = "completion-$Phase.json"
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control "recovery-lock/$name"), $text)
    $Context.Files.Add($file)
    $Context.RecoveryFiles['recovery-lock'] = @($Context.RecoveryFiles['recovery-lock'] + $name | Sort-Object)
    $Context.CompletionRecord = Read-AgentsChatMaintenanceFields $text $Context.CompletionSchema
    $Context.CompletionSha256 = $file.Sha256
    $Context.Phase = $Context.Step = $Phase
}

function Set-AgentsChatRecoveredColdPolicy([hashtable]$Context, [switch]$Enable) {
    $task = $Context.Folder.GetTask($Context.TaskName)
    $principal = $task.Definition.Principal
    $Context.TaskFile.Check()
    $Context.TaskFile.Dispose()
    $null = $Context.Files.Remove($Context.TaskFile)
    $Context.TaskFile = $null
    if ($Enable) { $task.Enabled = $Context.TargetEnabled }
    else {
        $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.Definition, (4 -bor 16 -bor 32),
            [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
    }
    $task = $Context.Folder.GetTask($Context.TaskName)
    $enabled = $Enable -and $Context.TargetEnabled
    if ([bool]$task.Enabled -ne $enabled -or [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Cold recovered task policy changed its enabled value or security.'
    }
    if ($enabled) { Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $Context.Definition }
    elseif (([xml]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml) {
        throw 'Cold recovered disabled permanent task differs.'
    }
    $Context.NativeDefinition = [string]$task.Xml
    $Context.Enabled = [bool]$task.Enabled
    Retain-AgentsChatColdRecoveryTaskFile $Context
    $Context.Step = if ($Enable) { 'enable-applied' } else { 'permanent-policy-applied' }
}

function Advance-AgentsChatColdCompletionRecovery([hashtable]$Context) {
    if (-not $Context.CompletionRecovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Cold completion recovery is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatColdCompletionEvidence $Context
        switch -CaseSensitive ($Context.Step) {
            'release-requested' { Write-AgentsChatRecoveredColdCompletion $Context 'released' }
            'released' { Write-AgentsChatRecoveredColdCompletion $Context 'policy-restore-requested' }
            'policy-restore-requested' { Set-AgentsChatRecoveredColdPolicy $Context }
            'permanent-policy-applied' { Write-AgentsChatRecoveredColdCompletion $Context 'policy-restored' }
            'policy-restored' { Write-AgentsChatRecoveredColdCompletion $Context 'enable-requested' }
            'enable-requested' { Set-AgentsChatRecoveredColdPolicy $Context -Enable }
            'enable-applied' { Write-AgentsChatRecoveredColdCompletion $Context 'complete' }
            'complete' { }
            default { throw 'Unsupported cold completion recovery step.' }
        }
        Assert-AgentsChatColdCompletionEvidence $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Cold completion recovery refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
    return Assert-AgentsChatColdCompletionProof $Context
}

function Open-AgentsChatColdCompletionRecovery {
    param([string]$Control, [string]$OwnerSha256, [string]$ReceiptSha256,
        [string]$IntentSha256, [string]$HistorySha256, [string]$CompletionSha256)
    $proof = Open-AgentsChatStoppedRestoreEvidence -Control $Control -Recovery -ActivationHistory `
        -CompletionHistory -CompletionRecovery
    try {
        Read-AgentsChatColdActivationRecoveryHistory $proof $OwnerSha256 $ReceiptSha256 $IntentSha256 $HistorySha256
        Read-AgentsChatColdCompletionHistory $proof $CompletionSha256
        $proof.Definition = $proof.CompletionRecord.permanentDefinition.GetString()
        Retain-AgentsChatColdCompletionAuthority $proof
        Initialize-AgentsChatCompletionRuntime $proof $proof.CompletionRecord
        Resolve-AgentsChatCompletionRecoveryPolicy $proof
        Retain-AgentsChatColdRecoveryTaskFile $proof
        $null = Assert-AgentsChatColdCompletionProof $proof
        return $proof
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $proof }
        catch { throw [AggregateException]::new('Cold completion recovery and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
