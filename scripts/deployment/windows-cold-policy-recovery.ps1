function Advance-AgentsChatColdPolicyRecovery([hashtable]$Context) {
    if (-not $Context.PolicyRecovery -or $Context.Closed -or $Context.Poisoned -or $Context.Busy) {
        throw 'Cold policy recovery authority is unavailable.'
    }
    $null = Assert-AgentsChatColdActivationRecoveryProof $Context
    $Context.Busy = $true
    try {
        if (-not $Context.PolicyClaimed) {
            Write-AgentsChatColdPolicyRecord $Context 'claim' $Context.PolicyDurableStep
        } else {
            switch -CaseSensitive ($Context.PolicyStep) {
                'initial' {
                    Write-AgentsChatColdPolicyRecord $Context 'request' 'requested'
                    $Context.PolicyStep = 'requested'
                }
                'requested' {
                    $task = $Context.Folder.GetTask($Context.TaskName)
                    $principal = $task.Definition.Principal
                    $Context.TaskFile.Check()
                    $Context.TaskFile.Dispose()
                    $null = $Context.Files.Remove($Context.TaskFile)
                    $Context.TaskFile = $null
                    $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.Definition, (4 -bor 16 -bor 32),
                        [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
                    $task = $Context.Folder.GetTask($Context.TaskName)
                    if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
                        ([xml]$task.Xml).OuterXml -cne ([xml]$Context.Definition).OuterXml -or
                        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
                        throw 'Recovered cold task differs from its exact original disabled policy or security.'
                    }
                    $Context.CurrentDefinition = [string]$task.Xml
                    $Context.CurrentEnabled = $false
                    Retain-AgentsChatColdRecoveryTaskFile $Context
                    $Context.PolicyStep = 'policy-applied'
                }
                'policy-applied' {
                    Write-AgentsChatColdPolicyRecord $Context 'restored' 'restored'
                    $Context.PolicyStep = 'restored'
                }
                'restored' { }
                default { throw 'Unsupported cold policy recovery step.' }
            }
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Cold task policy recovery refused; retain its full owner journal.', $_.Exception)
    } finally { $Context.Busy = $false }
    return Assert-AgentsChatColdActivationRecoveryProof $Context
}
