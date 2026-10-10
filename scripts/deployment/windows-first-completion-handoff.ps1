. (Join-Path $PSScriptRoot 'windows-first-deployment-identity.ps1')

function Prepare-AgentsChatFirstCompletion {
    param([hashtable]$Context, [string[]]$Providers, [hashtable]$DeploymentIdentity, [scriptblock]$CheckAuthority)
    if ($Context.CompletionPrepared -or $null -eq $Context.Activation -or
        $null -eq $Context.Activation.Runtime -or $Context.Activation.Stopped -or
        $null -eq $Context.Listener -or $null -eq $Context.ActivatingStateFile -or
        $Providers.Count -lt 1 -or $Providers.Count -gt 3 -or
        @($Providers | Select-Object -Unique).Count -ne $Providers.Count -or
        @($Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
        throw 'First completion requires original active readiness and unused activating authority.'
    }
    & $CheckAuthority
    $identity = Read-AgentsChatFirstDeploymentIdentity ($DeploymentIdentity | ConvertTo-Json -Compress)
    if ($identity.source -cne $Context.ActivatingStateFields.targetCommit.GetString()) {
        throw 'First completion build identity differs from the original target.'
    }
    $listener = Open-AgentsChatFirstRuntimeListener $Context $CheckAuthority
    $receipt = [ordered]@{
        status='first-completion-prepared'; runtimeAuthority=$false
        project=$Context.Project; operationId=$Context.OperationId; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity
        lockSha256=$Context.LockSha256; activatingStateSha256=$Context.ActivatingStateSha256
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        generation=$Context.Activation.Runtime.generation; port=$Context.Port
        providers=@($Providers); listener=$listener; deploymentIdentity=$identity
    }
    $prepared = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Control "first-task-$($Context.OperationId)/completion-prepared.json"),
        ($receipt | ConvertTo-Json -Depth 5 -Compress)))
    $Context.CompletionSha256 = $prepared.Sha256
    $Context.CompletionProviders = $Providers.Clone()
    $Context.CompletionListener = $listener
    & $CheckAuthority
    $Context.ActivatingStateFile.Check()
    $Context.ActivatingStateFile.Dispose()
    $null = $Context.Checks.Remove($Context.ActivatingStateFile)
    $null = $Context.Resources.Remove($Context.ActivatingStateFile)
    $Context.CompletionPrepared = $true
    $Context.CompletionStep = 'prepared'
    Assert-AgentsChatFirstActivationState $Context
    return $receipt
}
