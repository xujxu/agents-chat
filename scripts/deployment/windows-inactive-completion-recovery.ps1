. (Join-Path $PSScriptRoot 'windows-inactive-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-task-completion-recovery.ps1')

function Assert-AgentsChatInactiveRecoveryEvidence([hashtable]$Context) {
    foreach ($name in @('task-retirement.json', 'task-retirement-checkpoint.json', 'worker-retirement.json')) {
        if (Test-Path -LiteralPath (Join-Path $Context.Control $name)) {
            throw 'Inactive completion recovery conflicts with retirement evidence.'
        }
    }
    Assert-AgentsChatInactiveCompletionEvidence $Context
}

function Assert-AgentsChatInactiveCompletionRecovery([hashtable]$Context) {
    if (-not $Context.Recovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Inactive completion recovery is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatInactiveRecoveryEvidence $Context
        return Get-AgentsChatCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally { $Context.Busy = $false }
}

function Advance-AgentsChatInactiveCompletionRecovery([hashtable]$Context) {
    if (-not $Context.Recovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Inactive completion recovery is unavailable.'
    }
    $Context.Busy = $true
    try {
        Assert-AgentsChatInactiveRecoveryEvidence $Context
        switch -CaseSensitive ($Context.Step) {
            'release-requested' { Write-AgentsChatRecoveredCompletionReceipt $Context 'released' -Inactive }
            'released' { Write-AgentsChatRecoveredCompletionReceipt $Context 'policy-restore-requested' -Inactive }
            'policy-restore-requested' {
                $task = $Context.Folder.GetTask($Context.TaskName)
                $principal = $task.Definition.Principal
                $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.Definition, (4 -bor 16 -bor 32),
                    [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
                $task = $Context.Folder.GetTask($Context.TaskName)
                if ($task.Enabled -or ([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml -or
                    [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                    throw 'Recovered inactive permanent policy differs.'
                }
                $Context.NativeDefinition = [string]$task.Xml
                $Context.Step = 'permanent-policy-applied'
            }
            'permanent-policy-applied' { Write-AgentsChatRecoveredCompletionReceipt $Context 'complete' -Inactive }
            'complete' { }
            default { throw 'Unsupported inactive recovery step.' }
        }
        Assert-AgentsChatInactiveRecoveryEvidence $Context
        return Get-AgentsChatCompletionRecoveryObservation $Context
    } catch {
        $Context.Poisoned = $true
        throw
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatInactiveCompletionRecovery([string]$Control) {
    $context = Open-AgentsChatInactiveCompletionContext $Control -ReleasedPrefix
    try {
        $context.Recovery = $true
        $null = Assert-AgentsChatInactiveCompletionRecovery $context
        return $context
    } catch {
        $failure = $_.Exception
        try { Close-AgentsChatTaskCompletionProof $context }
        catch {
            throw [AggregateException]::new('Inactive recovery open and cleanup failed.',
                [Exception[]]@($failure, $_.Exception))
        }
        throw $failure
    }
}
