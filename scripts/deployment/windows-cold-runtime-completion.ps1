function Write-AgentsChatColdCompletionReceipt([hashtable]$Context, [string]$Phase) {
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    $Context.Listener.Check()
    $record = [ordered]@{
        version=1; phase=$Phase; previousSha256=$Context.CompletionSha256
        operationId=$Context.Proof.OperationId; ownerSha256=$Context.OwnerSha256
        filesReceiptSha256=$Context.ReceiptSha256; intentSha256=$Context.IntentSha256
        historySha256=$Context.CompletionHistorySha256; stateSha256=$Context.Proof.StateSha256
        controllerPid=$PID; controllerIdentity=$Context.Identity
        runtime=$Context.Runtime; taskName=$Context.TaskName
        configuration=$Context.Configuration; configurationSha256=$Context.ConfigurationSha256
        guardedDefinition=$Context.PlannedDefinition
        stagedDefinition=$Context.CompletionStagedDefinition; permanentDefinition=$Context.CompletionPermanentDefinition
        targetEnabled=$Context.CompletionTargetEnabled; securityDescriptor=$Context.SecurityDescriptor
        definition=$Context.Definition; enabled=$Context.Enabled
        lease=$(if ($Context.LeaseReleased) { 'released' } else { 'guarded' })
        port=$Context.CompletionPort; providers=$Context.CompletionProviders
        listenerPid=$Context.Listener.ListenerPid; listenerIdentity=$Context.Listener.ListenerIdentity
        listenerAddress=$Context.Listener.Address; listenerCreatedAt=$Context.Listener.CreatedAt
        listenerPairedRecords=$Context.Listener.PairedRecords
    }
    $name = "completion-$Phase.json"
    $file = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory $name), ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Proof.Files.Add($file)
    $Context.Proof.RecoveryFiles['recovery-lock'] = @(@($Context.Proof.RecoveryFiles['recovery-lock']) + $name | Sort-Object)
    $Context.CompletionSha256 = $file.Sha256
    $Context.CompletionStep = $Phase
    $null = Assert-AgentsChatColdActivatedRuntime $Context
}

function Prepare-AgentsChatColdRuntimeCompletion([hashtable]$Context, [int]$Port, [string[]]$Providers) {
    $Context.Stage = 'cold-completion-readiness'
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    if (-not $Context.Listener -or $Context.Listener.Port -ne $Port -or
        $Providers.Count -lt 1 -or $Providers.Count -gt 3 -or
        @($Providers | Select-Object -Unique).Count -ne $Providers.Count -or
        @($Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Cold completion requires its retained listener and admitted providers.'
    }
    $Context.Listener.Check()
    if ($Context.CompletionPrepared) {
        if ($Context.CompletionPort -ne $Port -or
            ($Context.CompletionProviders | ConvertTo-Json -Compress) -cne ($Providers | ConvertTo-Json -Compress)) {
            throw 'Cold completion readiness changed.'
        }
        return
    }
    $policy = @{
        Definition=$Context.Proof.Definition; Bundle=$Context.Bundle; Configuration=$Context.Configuration
        ConfigurationSha256=$Context.ConfigurationSha256; Stage='cold-permanent-policy'
    }
    $permanent = Get-AgentsChatColdActivationDefinition $policy $PID $Context.Identity -Permanent
    $original = [xml]$Context.Proof.Admission.definition.GetString()
    $ns = [Xml.XmlNamespaceManager]::new($original.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $enabled = $original.SelectNodes('/t:Task/t:Settings/t:Enabled', $ns)
    if ($enabled.Count -gt 1 -or ($enabled.Count -eq 1 -and $enabled[0].InnerText -cnotin @('true', 'false'))) {
        throw 'Cold completion original enabled policy is unsupported.'
    }
    $Context.CompletionTargetEnabled = $enabled.Count -eq 0 -or $enabled[0].InnerText -ceq 'true'
    $staged = [xml]$Context.Definition
    $argumentPath = '/t:Task/t:Actions/t:Exec/t:Arguments'
    $staged.SelectSingleNode($argumentPath, $ns).InnerText =
        ([xml]$permanent).SelectSingleNode($argumentPath, $ns).InnerText
    $Context.CompletionStagedDefinition = $staged.OuterXml
    $Context.CompletionPermanentDefinition = $permanent
    $Context.CompletionPort = $Port
    $Context.CompletionProviders = $Providers.Clone()
    $Context.CompletionHistorySha256 = $Context.PreviousSha256
    $Context.CompletionSha256 = $Context.PreviousSha256
    Write-AgentsChatColdCompletionReceipt $Context 'prepared'
    $Context.CompletionPrepared = $true
}

function Publish-AgentsChatColdCompletionPolicy([hashtable]$Context, [string]$Definition) {
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    $Context.Listener.Check()
    $principal = $Context.Proof.Folder.GetTask($Context.TaskName).Definition.Principal
    $null = $Context.Proof.Folder.RegisterTask($Context.TaskName, $Definition, (4 -bor 16 -bor 32),
        [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
    $task = $Context.Proof.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or ([xml]$task.Xml).OuterXml -cne ([xml]$Definition).OuterXml -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Cold completion changed its disabled policy or security.'
    }
    $Context.Definition = [string]$task.Xml
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    $Context.Listener.Check()
}

function Complete-AgentsChatColdRuntime([hashtable]$Context, [int]$Port, [string[]]$Providers) {
    $prepared = $Context.CompletionPrepared
    Prepare-AgentsChatColdRuntimeCompletion $Context $Port $Providers
    if ($prepared) {
        $Context.Stage = "cold-completion-$($Context.CompletionStep)"
        switch -CaseSensitive ($Context.CompletionStep) {
            'prepared' { Write-AgentsChatColdCompletionReceipt $Context 'policy-requested' }
            'policy-requested' {
                Publish-AgentsChatColdCompletionPolicy $Context $Context.CompletionStagedDefinition
                $Context.CompletionStep = 'policy-applied'
            }
            'policy-applied' { Write-AgentsChatColdCompletionReceipt $Context 'policy-staged' }
            'policy-staged' { Write-AgentsChatColdCompletionReceipt $Context 'release-requested' }
            'release-requested' {
                $runtime = $Context.Runtime
                $reply = [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'release', 15000)
                if ($reply -cne 'released') { throw 'Original cold runtime lease release was not acknowledged.' }
                $Context.LeaseReleased = $true
                $Context.CompletionStep = 'lease-released'
            }
            'lease-released' { Write-AgentsChatColdCompletionReceipt $Context 'released' }
            'released' { Write-AgentsChatColdCompletionReceipt $Context 'policy-restore-requested' }
            'policy-restore-requested' {
                Publish-AgentsChatColdCompletionPolicy $Context $Context.CompletionPermanentDefinition
                $Context.CompletionStep = 'permanent-policy-applied'
            }
            'permanent-policy-applied' { Write-AgentsChatColdCompletionReceipt $Context 'policy-restored' }
            'policy-restored' { Write-AgentsChatColdCompletionReceipt $Context 'enable-requested' }
            'enable-requested' {
                $task = $Context.Proof.Folder.GetTask($Context.TaskName)
                $task.Enabled = $Context.CompletionTargetEnabled
                $task = $Context.Proof.Folder.GetTask($Context.TaskName)
                if ([bool]$task.Enabled -ne $Context.CompletionTargetEnabled) { throw 'Cold permanent enabled policy differs.' }
                if ($Context.CompletionTargetEnabled) {
                    Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $Context.Definition
                } elseif ([string]$task.Xml -cne $Context.Definition) { throw 'Cold permanent disabled policy differs.' }
                $Context.Definition = [string]$task.Xml
                $Context.Enabled = $Context.CompletionTargetEnabled
                $Context.CompletionStep = 'enable-applied'
            }
            'enable-applied' { Write-AgentsChatColdCompletionReceipt $Context 'complete' }
            'complete' { }
            default { throw 'Cold runtime completion has an unsupported step.' }
        }
    }
    $null = Assert-AgentsChatColdActivatedRuntime $Context
    $Context.Listener.Check()
    if ($Context.CompletionStep -ceq 'complete') {
        return [ordered]@{
            status='runtime-policy-restored'; step='complete'; lease='released'
            completionSha256=$Context.CompletionSha256; runtime=$Context.Runtime; taskName=$Context.TaskName
            configuration=$Context.Configuration; definition=$Context.Definition; enabled=$Context.Enabled
            port=$Context.CompletionPort; providers=$Context.CompletionProviders
        }
    }
    return [ordered]@{
        status='runtime-policy-progress'; step=$Context.CompletionStep
        lease=$(if ($Context.LeaseReleased) { 'released' } else { 'guarded' })
        completionSha256=$Context.CompletionSha256
    }
}
