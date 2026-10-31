function Write-AgentsChatFirstCompletionReceipt([hashtable]$Context, [string]$Phase, [scriptblock]$CheckAuthority) {
    & $CheckAuthority
    $task = Get-AgentsChatFirstActivationTask $Context
    $record = [ordered]@{
        version=1; phase=$Phase
        status=$(if ($Phase -ceq 'complete') { 'first-runtime-completed' } else { 'first-completion-progress' })
        project=$Context.Project; operationId=$Context.OperationId; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity
        lockSha256=$Context.LockSha256; activatingStateSha256=$Context.ActivatingStateSha256
        stateSha256=$Context.AcceptedStateSha256
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        runtime=$Context.Activation.Runtime; definition=[string]$task.Xml
        permanentDefinition=$Context.Activation.Task.Observation.permanentDefinition
        securityDescriptor=$Context.Activation.Task.Observation.securityDescriptor
        enabled=$Context.Activation.Enabled; lease=$Context.Activation.Lease
        port=$Context.Port; providers=@($Context.CompletionProviders); listener=$Context.CompletionListener
        previousSha256=$Context.CompletionSha256
    }
    $receipt = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Control "first-task-$($Context.OperationId)/completion-$Phase.json"),
        ($record | ConvertTo-Json -Depth 5 -Compress)))
    $Context.CompletionSha256 = $receipt.Sha256
    & $CheckAuthority
    return $record
}

function Publish-AgentsChatFirstCompletionPolicy([hashtable]$Context, [string]$Definition, [scriptblock]$CheckAuthority) {
    & $CheckAuthority
    $activation = $Context.Activation
    $task = Get-AgentsChatFirstActivationTask $Context
    if ($task.Enabled) { throw 'First completion policy must remain inhibited during replacement.' }
    $principal = $task.Definition.Principal
    $null = $activation.Task.Folder.RegisterTask($Context.TaskName, $Definition, (4 -bor 16 -bor 32),
        [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
    $task = $activation.Task.Folder.GetTask($Context.TaskName)
    if ($task.Enabled -or [string]$task.GetSecurityDescriptor(7) -cne $activation.Task.Observation.securityDescriptor) {
        throw 'First completion changed the original inhibited policy or security.'
    }
    Confirm-AgentsChatFirstTaskPolicy $Definition ([string]$task.Xml) $activation.Task.Observation.accountSid
    $activation.Definition = [string]$task.Xml
    & $CheckAuthority
}

function Advance-AgentsChatFirstCompletion([hashtable]$Context, [scriptblock]$CheckAuthority) {
    if (-not $Context.CompletionPrepared -or $Context.CompletionCompleted -or
        $null -eq $Context.AcceptedStateSha256 -or $null -eq $Context.Activation -or
        $Context.Activation.Stopped) {
        throw 'First completion requires unused original accepted authority.'
    }
    & $CheckAuthority
    $activation = $Context.Activation
    switch -CaseSensitive ($Context.CompletionStep) {
        'prepared' {
            if ($activation.Lease -cne 'guarded') { throw 'First completion preparation lost its guarded lease.' }
            $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Open(
                (Join-Path $Context.Control 'state.json'), $Context.AcceptedStateSha256))
            $permanent = [xml]$activation.Task.Observation.permanentDefinition
            $staged = [xml]$activation.Definition
            $namespaces = [Xml.XmlNamespaceManager]::new($permanent.NameTable)
            $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
            $arguments = '/t:Task/t:Actions/t:Exec/t:Arguments'
            $staged.SelectSingleNode($arguments, $namespaces).InnerText =
                $permanent.SelectSingleNode($arguments, $namespaces).InnerText
            $permanent.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText = 'false'
            $Context.CompletionStagedDefinition = $staged.OuterXml
            $Context.CompletionPermanentDefinition = $permanent.OuterXml
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'policy-requested' $CheckAuthority
            $Context.CompletionStep = 'policy-requested'
        }
        'policy-requested' {
            $activation.TaskFile.Check()
            $activation.TaskFile.Dispose()
            $null = $Context.Checks.Remove($activation.TaskFile)
            $null = $Context.Resources.Remove($activation.TaskFile)
            $activation.TaskFile = $null
            Publish-AgentsChatFirstCompletionPolicy $Context $Context.CompletionStagedDefinition $CheckAuthority
            $Context.CompletionStep = 'policy-applied'
        }
        'policy-applied' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'policy-staged' $CheckAuthority
            $Context.CompletionStep = 'policy-staged'
        }
        'policy-staged' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'release-requested' $CheckAuthority
            $Context.CompletionStep = 'release-requested'
        }
        'release-requested' {
            $runtime = $activation.Runtime
            if ([Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'release', 15000) -cne 'released') {
                throw 'Original first-runtime lease release was not acknowledged.'
            }
            $activation.Lease = 'released'
            $Context.CompletionStep = 'lease-released'
        }
        'lease-released' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'released' $CheckAuthority
            $Context.CompletionStep = 'released'
        }
        'released' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'policy-restore-requested' $CheckAuthority
            $Context.CompletionStep = 'policy-restore-requested'
        }
        'policy-restore-requested' {
            Publish-AgentsChatFirstCompletionPolicy $Context $Context.CompletionPermanentDefinition $CheckAuthority
            $Context.CompletionStep = 'permanent-policy-applied'
        }
        'permanent-policy-applied' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'policy-restored' $CheckAuthority
            $Context.CompletionStep = 'policy-restored'
        }
        'policy-restored' {
            $null = Write-AgentsChatFirstCompletionReceipt $Context 'enable-requested' $CheckAuthority
            $Context.CompletionStep = 'enable-requested'
        }
        'enable-requested' {
            $task = Get-AgentsChatFirstActivationTask $Context
            $task.Enabled = $true
            $activation.Enabled = $true
            $Context.CompletionStep = 'enable-applied'
        }
        'enable-applied' {
            $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$($Context.TaskName)"
            $taskHash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
            $activation.TaskFile = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $taskHash))
            $Context.CompletionRecord = Write-AgentsChatFirstCompletionReceipt $Context 'complete' $CheckAuthority
            $Context.CompletionCompleted = $true
            $Context.CompletionStep = 'complete'
        }
        default { throw 'Unsupported original first-completion step.' }
    }
    & $CheckAuthority
    return $Context.CompletionStep
}

function Complete-AgentsChatFirstRuntime([hashtable]$Context, [scriptblock]$CheckAuthority) {
    for ($index = 0; $index -lt 12; $index++) {
        if ((Advance-AgentsChatFirstCompletion $Context $CheckAuthority) -ceq 'complete') {
            return $Context.CompletionRecord
        }
    }
    throw 'First completion exceeded its finite step sequence.'
}
