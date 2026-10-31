function Write-AgentsChatInactiveCompletionReceipt([hashtable]$Context, [string]$Phase) {
    $null = Assert-AgentsChatInactiveTask $Context
    $completion = $Context.Completion
    $listener = $Context.InactiveListener
    $record = [ordered]@{
        version=1; kind='inactive'; phase=$Phase; operationId=$Context.ActivationPreparation.operationId
        preparationSha256=$Context.ActivationPreparationSha256; previousSha256=$completion.PreviousSha256
        activatingStateSha256=$Context.ActivationPreparation.stateSha256; activatingState=$Context.ActivatingState
        stateSha256=$completion.StateSha256; runtime=$Context.Startup.Runtime
        taskName=$Context.TaskName; definition=$Context.ReplacementDefinition
        stagedDefinition=$completion.StagedDefinition; enabled=$false; securityDescriptor=$Context.SecurityDescriptor
        port=$completion.Port; providers=$completion.Providers
        listenerPid=$listener.ListenerPid; listenerIdentity=$listener.ListenerIdentity
        listenerCreatedAt=$listener.CreatedAt; listenerAddress=$listener.Address
        listenerPairedRecords=$listener.PairedRecords
    }
    $file = Join-Path $Context.AdmissionControl "task-maintenance/inactive-complete-$Phase.json"
    $receipt = [Deployment.WindowsPrivateFile]::Publish($file, ($record | ConvertTo-Json -Depth 6 -Compress))
    $Context.Files.Add($receipt)
    $completion.PreviousSha256 = $receipt.Sha256
    $completion.Step = $Phase
    $null = Assert-AgentsChatInactiveTask $Context
    return [pscustomobject]@{ file=$file; sha256=$receipt.Sha256 }
}

function Prepare-AgentsChatInactiveCompletion([hashtable]$Context, [int]$Port, [string[]]$Providers) {
    $null = Assert-AgentsChatInactiveTask $Context
    if (-not $Context.ContainsKey('InactiveListener') -or $Context.InactiveListener.Port -ne $Port -or
        $Context.Startup.Phase -cne 'running' -or $Context.ContainsKey('Completion') -or
        $Providers.Count -lt 1 -or $Providers.Count -gt 3 -or
        @($Providers | Select-Object -Unique).Count -ne $Providers.Count -or
        @($Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'Inactive completion requires original running readiness and admitted providers.'
    }
    $staged = [xml]$Context.Startup.Definition
    $permanent = [xml]$Context.ReplacementDefinition
    $namespaces = [Xml.XmlNamespaceManager]::new($staged.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $argumentPath = '/t:Task/t:Actions/t:Exec/t:Arguments'
    $arguments = $staged.SelectNodes($argumentPath, $namespaces)
    $permanentArguments = $permanent.SelectNodes($argumentPath, $namespaces)
    if ($arguments.Count -ne 1 -or $permanentArguments.Count -ne 1) { throw 'Unsupported inactive completion action.' }
    $arguments[0].InnerText = $permanentArguments[0].InnerText
    $Context.Completion = @{
        Step='initial'; Port=$Port; Providers=$Providers.Clone(); StateSha256=$null
        PreviousSha256=$Context.Startup.PreviousSha256; StagedDefinition=$staged.OuterXml
    }
    $receipt = Write-AgentsChatInactiveCompletionReceipt $Context 'prepared'
    $Context.ActivationStateFile.Check()
    $Context.ActivationStateFile.Dispose()
    $null = $Context.Files.Remove($Context.ActivationStateFile)
    $Context.ActivationStateFile = $null
    return $receipt
}

function Retain-AgentsChatInactiveAcceptedState([hashtable]$Context, [string]$StateSha256) {
    $completion = $Context.Completion
    if ($StateSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Inactive completion requires an explicit terminal state hash.' }
    if ($completion.StateSha256) {
        if ($completion.StateSha256 -cne $StateSha256) { throw 'Original inactive accepted state changed.' }
        return
    }
    $path = Join-Path $Context.AdmissionControl 'state.json'
    if ((Get-Item -LiteralPath $path -Force).Length -gt 65536) { throw 'Oversized inactive accepted state.' }
    $file = [Deployment.WindowsPrivateFile]::Open($path, $StateSha256)
    try {
        $prior = $Context.ActivatingState
        $state = ConvertFrom-AgentsChatTaskTransactionState @{
            Project=$Context.Project; OperationId=$prior.operationId
            Generation=$Context.RetiredRuntime.generation; StartedAt=$prior.startedAt
        } ($file.ReadText()) -InactiveCompletion
        if ([string]::CompareOrdinal($state.updatedAt, $prior.updatedAt) -lt 0) {
            throw 'Inactive accepted state predates activation.'
        }
        foreach ($key in $prior.Keys) {
            if ($key -cnotin @('phase', 'previousPhase', 'updatedAt') -and $state[$key] -cne $prior[$key]) {
                throw 'Inactive completion changed original transaction fields.'
            }
        }
        $file.Check()
        $Context.Files.Add($file)
        $file = $null
        $completion.StateSha256 = $StateSha256
    } finally { if ($file) { $file.Dispose() } }
}

function Set-AgentsChatInactiveCompletionPolicy([hashtable]$Context, [string]$Definition) {
    $null = Assert-AgentsChatInactiveTask $Context
    $task = $Context.Folder.GetTask($Context.TaskName)
    $principal = $task.Definition.Principal
    $null = $Context.Folder.RegisterTask($Context.TaskName, $Definition, (4 -bor 16 -bor 32),
        [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or ([xml][string]$task.Xml).OuterXml -cne ([xml]$Definition).OuterXml -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Inactive permanent policy differs from its original disabled task.'
    }
    $Context.Startup.Definition = [string]$task.Xml
    $null = Assert-AgentsChatInactiveTask $Context
}

function Complete-AgentsChatInactiveTask([hashtable]$Context, [string]$StateSha256) {
    $null = Assert-AgentsChatInactiveTask $Context
    if (-not $Context.ContainsKey('Completion')) { throw 'Inactive completion requires native preparation.' }
    Retain-AgentsChatInactiveAcceptedState $Context $StateSha256
    $null = Assert-AgentsChatInactiveTask $Context
    $completion = $Context.Completion
    switch -CaseSensitive ($completion.Step) {
        'prepared' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'policy-requested' }
        'policy-requested' {
            Set-AgentsChatInactiveCompletionPolicy $Context $completion.StagedDefinition
            $completion.Step = 'policy-applied'
        }
        'policy-applied' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'policy-staged' }
        'policy-staged' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'release-requested' }
        'release-requested' {
            $runtime = $Context.Startup.Runtime
            if ([Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'release', 15000) -cne 'released') {
                throw 'Inactive runtime lease release was not acknowledged.'
            }
            $Context.Startup.LeaseReleased = $true
            $completion.Step = 'lease-released'
        }
        'lease-released' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'released' }
        'released' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'policy-restore-requested' }
        'policy-restore-requested' {
            Set-AgentsChatInactiveCompletionPolicy $Context $Context.ReplacementDefinition
            $completion.Step = 'permanent-policy-applied'
        }
        'permanent-policy-applied' { $null = Write-AgentsChatInactiveCompletionReceipt $Context 'complete' }
        default { throw 'Inactive completion was already attempted or its phase changed.' }
    }
    $null = Assert-AgentsChatInactiveTask $Context
    return $completion.Step
}
