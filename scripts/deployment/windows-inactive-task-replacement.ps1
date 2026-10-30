. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')

function Write-AgentsChatInactiveReplacementReceipt([hashtable]$Context, [string]$Phase,
    [string]$Definition, [string]$PreviousSha256) {
    $prepared = $Context.ActivationPreparation
    $record = [ordered]@{
        version=1; kind='inactive'; phase=$Phase; operationId=$prepared.operationId
        preparationSha256=$Context.ActivationPreparationSha256
        previousSha256=$PreviousSha256; stateSha256=$prepared.stateSha256
        taskName=$Context.TaskName
        originalDefinition=$(if ($Context.ContainsKey('ProvedDefinition')) { $Context.ProvedDefinition } else { $Context.NativeDefinition })
        definition=$Definition; securityDescriptor=$Context.SecurityDescriptor
        configuration=$prepared.configuration; configurationSha256=$prepared.configurationSha256
    }
    $file = Join-Path $Context.AdmissionControl "task-maintenance/inactive-$Phase.json"
    $receipt = [Deployment.WindowsPrivateFile]::Publish($file, ($record | ConvertTo-Json -Depth 5 -Compress))
    $Context.Files.Add($receipt)
    return [pscustomobject]@{ file=$file; sha256=$receipt.Sha256 }
}

function Publish-AgentsChatInactiveTaskReplacement([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveTask $Context
    if (-not $Context.ContainsKey('ActivationPreparation') -or $Context.ContainsKey('ReplacementRequested')) {
        throw 'Inactive replacement requires one original native activation preparation.'
    }
    $prepared = $Context.ActivationPreparation
    if ($prepared.configuration -match '%|\$\(') { throw 'Replacement configuration is not literal for Task Scheduler.' }
    $task = $Context.Folder.GetTask($Context.TaskName)
    $definition = $task.Definition
    if ($definition.Actions.Count -ne 1 -or [int]$definition.Actions.Item(1).Type -ne 0 -or
        [int]$definition.Principal.LogonType -notin @(2, 3)) { throw 'Unsupported inactive replacement policy.' }
    $requestedDefinition = New-AgentsChatTaskReplacementDefinition $Context.NativeDefinition `
        $prepared.configuration $prepared.configurationSha256 $Context
    $null = Assert-AgentsChatInactiveTask $Context
    $requested = Write-AgentsChatInactiveReplacementReceipt $Context 'replacement-requested' `
        $requestedDefinition $Context.ActivationPreparationSha256
    $Context.ReplacementRequested = $true
    $null = Assert-AgentsChatInactiveTask $Context
    $null = $Context.Folder.RegisterTask($Context.TaskName, $requestedDefinition, (4 -bor 16 -bor 32),
        [string]$definition.Principal.UserId, $null, [int]$definition.Principal.LogonType, $null)
    $task = $Context.Folder.GetTask($Context.TaskName)
    if ($task.Path -cne "\$($Context.TaskName)" -or $task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
        [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
        throw 'Inactive replacement changed task identity, inhibition or security.'
    }
    Confirm-AgentsChatTaskReplacementPolicy $requestedDefinition ([string]$task.Xml) $Context
    if (([xml][string]$task.Xml).OuterXml -cne ([xml]$requestedDefinition).OuterXml) {
        throw 'Registered inactive replacement definition differs.'
    }
    $Context.ReplacementDefinition = [string]$task.Xml
    $null = Assert-AgentsChatInactiveTask $Context
    $receipt = Write-AgentsChatInactiveReplacementReceipt $Context 'replacement-complete' `
        $Context.ReplacementDefinition $requested.sha256
    $Context.ReplacementSha256 = $receipt.sha256
    $null = Assert-AgentsChatInactiveTask $Context
    return [pscustomobject]@{
        replaced=$true; inhibited=$true; definition=$Context.ReplacementDefinition
        file=$receipt.file; sha256=$receipt.sha256
    }
}
