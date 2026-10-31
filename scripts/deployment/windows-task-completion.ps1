function Write-AgentsChatTaskCompletionReceipt([hashtable]$Context, [string]$Phase) {
    $Context.Stage = 'completion-receipt'
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.Data.operationId
        admissionSha256=$Context.AdmissionSha256; transactionSha256=$Context.Transaction.ReceiptSha256
        previousSha256=$Context.CompletionSha256; activatingStateSha256=$Context.RetirementStateSha256
        activatingState=$Context.CompletionPriorState
        stateSha256=$Context.CompletionStateSha256; runtime=$Context.ActivationRuntime
        taskName=$Context.Data.taskName; definition=$Context.ReplacementDefinition
        stagedDefinition=$Context.CompletionStagedDefinition
        enabled=$Context.CompletionTargetEnabled; securityDescriptor=$Context.Data.securityDescriptor
        port=$Context.CompletionPort; providers=$Context.CompletionProviders
        listenerPid=$Context.Listener.ListenerPid; listenerIdentity=$Context.Listener.ListenerIdentity
        listenerCreatedAt=$Context.Listener.CreatedAt; listenerAddress=$Context.Listener.Address
        listenerPairedRecords=$Context.Listener.PairedRecords
    }
    $receipt = [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory "task-complete-$Phase.json"), ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Files.Add($receipt)
    $Context.CompletionSha256 = $receipt.Sha256
    $Context.CompletionStep = $Phase
}

function Prepare-AgentsChatTaskCompletion {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string[]]$Providers)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        $Context.Stage = 'completion-readiness'
        if (-not $Context.Activated -or -not $Context.Listener -or $Context.Listener.Port -ne $Port -or
            $Providers.Count -lt 1 -or $Providers.Count -gt 3 -or
            @($Providers | Select-Object -Unique).Count -ne $Providers.Count -or
            @($Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
            throw 'Completion requires retained native listener and admitted providers.'
        }
        Test-AgentsChatActiveTaskContext $Context
        if ($Context.CompletionPrepared) {
            if ($Context.CompletionPort -ne $Port -or
                ($Context.CompletionProviders | ConvertTo-Json -Compress) -cne ($Providers | ConvertTo-Json -Compress)) {
                throw 'Original completion readiness differs.'
            }
            return
        }
        $Context.Stage = 'completion-state'
        $Context.CompletionPriorState = Read-AgentsChatTaskTransactionState $Context.Transaction ''
        if ($Context.Transaction.StateSha256 -cne $Context.RetirementStateSha256) { throw 'Original activating state differs.' }
        $original = [xml]$Context.Data.definition
        $namespaces = [Xml.XmlNamespaceManager]::new($original.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $enabled = $original.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        if ($enabled.Count -gt 1 -or ($enabled.Count -eq 1 -and $enabled[0].InnerText -cnotin @('true', 'false'))) {
            throw 'Unsupported original enabled policy.'
        }
        $Context.CompletionTargetEnabled = $enabled.Count -eq 0 -or $enabled[0].InnerText -ceq 'true'
        $staged = [xml]$Context.ActivationDefinition
        $permanent = [xml]$Context.ReplacementDefinition
        $argumentPath = '/t:Task/t:Actions/t:Exec/t:Arguments'
        $staged.SelectSingleNode($argumentPath, $namespaces).InnerText =
            $permanent.SelectSingleNode($argumentPath, $namespaces).InnerText
        $Context.CompletionStagedDefinition = $staged.OuterXml
        $Context.CompletionPort = $Port
        $Context.CompletionProviders = $Providers.Clone()
        $Context.CompletionSha256 = $Context.ActivationSha256
        Test-AgentsChatActiveTaskContext $Context
        Write-AgentsChatTaskCompletionReceipt $Context 'prepared'
        $Context.CompletionPrepared = $true
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}

function Publish-AgentsChatTaskCompletionPolicy([hashtable]$Context, [string]$Definition) {
    Test-AgentsChatActiveTaskContext $Context
    $Context.Stage = 'completion-registration'
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    $principal = $task.Definition.Principal
    $null = $Context.Folder.RegisterTask($Context.Data.taskName, $Definition, (4 -bor 16 -bor 32),
        [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    if ($task.Enabled -or ([xml][string]$task.Xml).OuterXml -cne ([xml]$Definition).OuterXml -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) {
        throw 'Disabled completion policy differs.'
    }
    $Context.CompletionDefinition = [string]$task.Xml
    Test-AgentsChatActiveTaskContext $Context
}

function Set-AgentsChatTaskCompletionEnabled([hashtable]$Context) {
    Test-AgentsChatActiveTaskContext $Context
    $disabledDefinition = $Context.CompletionDefinition
    $Context.Stage = 'completion-enable-write'
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    $task.Enabled = $Context.CompletionTargetEnabled
    $Context.Stage = 'completion-enable-read'
    $task = $Context.Folder.GetTask($Context.Data.taskName)
    $Context.Stage = 'completion-enable-value'
    if ([bool]$task.Enabled -ne $Context.CompletionTargetEnabled) { throw 'Permanent enabled value differs.' }
    $Context.Stage = 'completion-enable-definition'
    if ($Context.CompletionTargetEnabled) {
        Confirm-AgentsChatTaskInhibition ([string]$task.Xml) $disabledDefinition
    } elseif ([string]$task.Xml -cne $disabledDefinition) {
        throw 'Permanent disabled definition differs.'
    }
    $Context.Stage = 'completion-enable-security'
    if ([string]$task.GetSecurityDescriptor(7) -cne $Context.Data.securityDescriptor) { throw 'Permanent security differs.' }
    $Context.CompletionDefinition = [string]$task.Xml
    $Context.CompletionEnabled = $Context.CompletionTargetEnabled
    Test-AgentsChatActiveTaskContext $Context
}

function Advance-AgentsChatTaskCompletion {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$StateSha256)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        $Context.Stage = 'completion-state'
        if (-not $Context.CompletionPrepared -or $StateSha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Completion requires prepared native readiness and an explicit state digest.'
        }
        if ($Context.CompletionStateSha256 -and $StateSha256 -cne $Context.CompletionStateSha256) {
            throw 'Original completion digest differs.'
        }
        if ($Context.Completed) {
            Test-AgentsChatActiveTaskContext $Context
            return 'complete'
        }
        $prior = $Context.CompletionPriorState
        $state = Read-AgentsChatTaskTransactionState $Context.Transaction ''
        $recoveringPrior = $Context.Transaction.PriorRuntimeRecovery
        $terminal = if ($recoveringPrior) { 'prior-runtime-restored' } `
            elseif ($prior.operation -ceq 'restore') { 'restored' } else { 'accepted' }
        if ($Context.Transaction.StateSha256 -cne $StateSha256 -or $state.phase -cne $terminal -or
            $state.previousPhase -cne $prior.phase -or
            [string]::CompareOrdinal($state.updatedAt, $prior.updatedAt) -lt 0) {
            throw 'Completion state does not follow the original activation.'
        }
        foreach ($key in $prior.Keys) {
            if ($key -cnotin @('phase', 'previousPhase', 'updatedAt') -and
                -not ($recoveringPrior -and $key -ceq 'errorCode') -and $state[$key] -cne $prior[$key]) {
                throw 'Completion changed original transaction fields.'
            }
        }
        $Context.CompletionStateSha256 = $StateSha256
        $Context.Transaction.CompletionStateSha256 = $StateSha256
        Test-AgentsChatActiveTaskContext $Context
        switch -CaseSensitive ($Context.CompletionStep) {
            'prepared' { Write-AgentsChatTaskCompletionReceipt $Context 'policy-requested' }
            'policy-requested' {
                Publish-AgentsChatTaskCompletionPolicy $Context $Context.CompletionStagedDefinition
                $Context.CompletionStep = 'policy-applied'
            }
            'policy-applied' { Write-AgentsChatTaskCompletionReceipt $Context 'policy-staged' }
            'policy-staged' { Write-AgentsChatTaskCompletionReceipt $Context 'release-requested' }
            'release-requested' {
                $Context.Stage = 'completion-release'
                $runtime = $Context.ActivationRuntime
                $reply = [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'release', 15000)
                if ($reply -cne 'released') { throw 'Original runtime lease release was not acknowledged.' }
                Test-AgentsChatActiveTaskContext $Context
                $Context.CompletionStep = 'lease-released'
            }
            'lease-released' { Write-AgentsChatTaskCompletionReceipt $Context 'released' }
            'released' { Write-AgentsChatTaskCompletionReceipt $Context 'policy-restore-requested' }
            'policy-restore-requested' {
                Publish-AgentsChatTaskCompletionPolicy $Context $Context.ReplacementDefinition
                $Context.CompletionStep = 'permanent-policy-applied'
            }
            'permanent-policy-applied' { Write-AgentsChatTaskCompletionReceipt $Context 'policy-restored' }
            'policy-restored' { Write-AgentsChatTaskCompletionReceipt $Context 'enable-requested' }
            'enable-requested' {
                Set-AgentsChatTaskCompletionEnabled $Context
                $Context.CompletionStep = 'enable-applied'
            }
            'enable-applied' {
                Write-AgentsChatTaskCompletionReceipt $Context 'complete'
                $Context.Completed = $true
            }
            default { throw 'Unsupported original completion step.' }
        }
        Test-AgentsChatActiveTaskContext $Context
        return $Context.CompletionStep
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}

function Complete-AgentsChatTaskActivation {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$StateSha256)
    for ($index = 0; $index -lt 12; $index++) {
        if ((Advance-AgentsChatTaskCompletion -Context $Context -StateSha256 $StateSha256) -ceq 'complete') { return }
    }
    $Context.Poisoned = $true
    throw 'Task completion exceeded its finite step sequence.'
}
