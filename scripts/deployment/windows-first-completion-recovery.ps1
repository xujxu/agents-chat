. (Join-Path $PSScriptRoot 'windows-first-completion-proof.ps1')

function Get-AgentsChatFirstCompletionRecoveryObservation([hashtable]$Context) {
    return [pscustomobject][ordered]@{
        status=$(if ($Context.Phase -ceq 'complete') { 'complete' } else { 'pending' })
        phase=$Context.Phase; step=$Context.Step
        operationId=$Context.OperationId; taskName=$Context.TaskName
        stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
        runtime=[pscustomobject]$Context.Runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
    }
}

function Assert-AgentsChatFirstCompletionRecovery([hashtable]$Context) {
    if (-not $Context.Recovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'First completion recovery is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatFirstCompletionEvidence $Context
        return Get-AgentsChatFirstCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("First completion recovery refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Write-AgentsChatRecoveredFirstCompletionReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'recovery-receipt'
    $document = [Text.Json.JsonDocument]::Parse($Context.CompletionText)
    try {
        $properties = [Collections.Generic.List[string]]::new()
        foreach ($property in $document.RootElement.EnumerateObject()) {
            $value = switch -CaseSensitive ($property.Name) {
                'phase' { '"' + $Phase + '"' }
                'status' { if ($Phase -ceq 'complete') { '"first-runtime-completed"' } else { '"first-completion-progress"' } }
                'previousSha256' { '"' + $Context.CompletionSha256 + '"' }
                'definition' { ConvertTo-Json -InputObject $Context.NativeDefinition -Compress }
                'enabled' { if ($Context.Enabled) { 'true' } else { 'false' } }
                'lease' { '"released"' }
                default { $property.Value.GetRawText() }
            }
            # Retain the original transaction's nested snapshots and publisher identity.
            $properties.Add('"' + $property.Name + '":' + $value)
        }
        $text = '{' + ($properties -join ',') + '}'
    } finally { $document.Dispose() }
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Directory "completion-$Phase.json"), $text)
    $Context.Files.Add($file)
    $Context.RecordNames += "completion-$Phase"
    $Context.CompletionText = $text
    $Context.CompletionSha256 = $file.Sha256
    $Context.Phase = $Phase
    $Context.Step = $Phase
}

function Release-AgentsChatFirstCompletionTaskFile([hashtable]$Context) {
    $Context.TaskFile.Check()
    $Context.TaskFile.Dispose()
    $null = $Context.Files.Remove($Context.TaskFile)
    $Context.TaskFile = $null
}

function Advance-AgentsChatFirstCompletionRecovery([hashtable]$Context) {
    if (-not $Context.Recovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'First completion recovery is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatFirstCompletionEvidence $Context
        switch -CaseSensitive ($Context.Step) {
            'lease-released' { Write-AgentsChatRecoveredFirstCompletionReceipt $Context 'released' }
            'released' { Write-AgentsChatRecoveredFirstCompletionReceipt $Context 'policy-restore-requested' }
            'policy-restore-requested' {
                $Context.Stage = 'recovery-registration'
                $task = $Context.Folder.GetTask($Context.TaskName)
                $principal = $task.Definition.Principal
                Release-AgentsChatFirstCompletionTaskFile $Context
                $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.PermanentDisabledDefinition, (4 -bor 16 -bor 32),
                    [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
                $task = $Context.Folder.GetTask($Context.TaskName)
                if ($task.Enabled -or [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                    throw 'Recovered first-task disabled policy or security differs.'
                }
                Confirm-AgentsChatFirstTaskPolicy $Context.PermanentDisabledDefinition ([string]$task.Xml) $Context.AccountSid
                $Context.NativeDefinition = [string]$task.Xml
                Retain-AgentsChatFirstCompletionTaskFile $Context
                $Context.Step = 'permanent-policy-applied'
            }
            'permanent-policy-applied' { Write-AgentsChatRecoveredFirstCompletionReceipt $Context 'policy-restored' }
            'policy-restored' { Write-AgentsChatRecoveredFirstCompletionReceipt $Context 'enable-requested' }
            'enable-requested' {
                $Context.Stage = 'recovery-enable'
                $task = $Context.Folder.GetTask($Context.TaskName)
                Release-AgentsChatFirstCompletionTaskFile $Context
                $task.Enabled = $true
                $task = $Context.Folder.GetTask($Context.TaskName)
                if (-not $task.Enabled -or [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                    throw 'Recovered first-task enabled policy or security differs.'
                }
                Confirm-AgentsChatFirstTaskPolicy $Context.PermanentDefinition ([string]$task.Xml) $Context.AccountSid
                $Context.NativeDefinition = [string]$task.Xml
                $Context.Enabled = $true
                Retain-AgentsChatFirstCompletionTaskFile $Context
                $Context.Step = 'enable-applied'
            }
            'enable-applied' { Write-AgentsChatRecoveredFirstCompletionReceipt $Context 'complete' }
            'complete' { }
            default { throw 'Unsupported first-completion recovery step.' }
        }
        Assert-AgentsChatFirstCompletionEvidence $Context
        return Get-AgentsChatFirstCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("First completion recovery refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}
