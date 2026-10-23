. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')

function Get-AgentsChatInactiveRollbackTaskText([hashtable]$Context, [string]$Phase) {
    $directory = Join-Path $Context.Control 'inactive-rollback-runtime'
    $configuration = Join-Path $directory 'configuration.json'
    $sha256 = $Context.Admission.configurationSha256.GetString()
    $definition = New-AgentsChatTaskReplacementDefinition $Context.Admission.definition.GetString() `
        $configuration $sha256 $Context
    $record = [ordered]@{
        version=1; phase=$Phase; operationId=$Context.OperationId; stateSha256=$Context.StateSha256
        filesSha256=$Context.RollbackTaskFiles.Sha256; taskName=$Context.TaskName
        priorRuntime='stopped'; definition=$definition; securityDescriptor=$Context.SecurityDescriptor
        runtimeBundle=[ordered]@{ directory=$directory; configuration=$configuration; sha256=$sha256 }
    }
    if ($Phase -ceq 'task-restored') { $record.intentSha256 = $Context.RollbackTaskIntent.Sha256 }
    return ($record | ConvertTo-Json -Depth 5 -Compress)
}

function Open-AgentsChatInactiveRollbackTaskHistory([hashtable]$Context) {
    $intentPath = Join-Path $Context.Control 'inactive-rollback-task-intent.json'
    $receiptPath = Join-Path $Context.Control 'inactive-rollback-task-restored.json'
    if (-not (Test-Path -LiteralPath $intentPath)) {
        if (Test-Path -LiteralPath $receiptPath) { throw 'Rollback task receipt has no original intent.' }
        return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Context.Control 'inactive-rollback-intent.json'))) {
        throw 'Rollback task history has no original rollback intent.'
    }
    $Context.RollbackTaskFiles = Open-AgentsChatCompletionFile $Context `
        (Join-Path $Context.Control 'inactive-rollback-files-restored.json') ''
    $Context.RollbackTaskIntent = Open-AgentsChatCompletionFile $Context $intentPath ''
    $expected = Get-AgentsChatInactiveRollbackTaskText $Context 'task-restore-requested'
    if ($Context.RollbackTaskIntent.ReadText() -cne $expected) { throw 'Rollback task intent differs from original policy.' }
    $Context.RollbackTaskDefinition = ($expected | ConvertFrom-Json).definition
    $Context.RollbackTaskComplete = $false
    if (Test-Path -LiteralPath $receiptPath) {
        $Context.RollbackTaskReceipt = Open-AgentsChatCompletionFile $Context $receiptPath ''
        if ($Context.RollbackTaskReceipt.ReadText() -cne (Get-AgentsChatInactiveRollbackTaskText $Context 'task-restored')) {
            throw 'Rollback task receipt differs from original intent.'
        }
        $Context.RollbackTaskComplete = $true
    }
}

function Restore-AgentsChatInactiveRollbackTask([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ContainsKey('ExclusiveLostRuntime') -or -not $Context.ExclusiveLostRuntime -or
        -not $Context.ContainsKey('RollbackFilesReceipt')) {
        throw 'Task rollback requires exclusive authority and retained files-restored receipt.'
    }
    if (-not $Context.ContainsKey('RollbackTaskIntent')) {
        $Context.RollbackTaskFiles = $Context.RollbackFilesReceipt
        $text = Get-AgentsChatInactiveRollbackTaskText $Context 'task-restore-requested'
        $Context.RollbackTaskIntent = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control 'inactive-rollback-task-intent.json'), $text)
        $Context.Files.Add($Context.RollbackTaskIntent)
        $Context.RollbackTaskDefinition = ($text | ConvertFrom-Json).definition
        $Context.RollbackTaskComplete = $false
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.RollbackTaskComplete) {
        $task = $Context.Folder.GetTask($Context.TaskName)
        if (([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.RollbackTaskDefinition).OuterXml) {
            $principal = $task.Definition.Principal
            if ([int]$principal.LogonType -notin @(2, 3)) { throw 'Unsupported rollback task logon policy.' }
            $null = $Context.Folder.RegisterTask($Context.TaskName, $Context.RollbackTaskDefinition,
                (4 -bor 16 -bor 32), [string]$principal.UserId, $null, [int]$principal.LogonType, $null)
        }
        $task = $Context.Folder.GetTask($Context.TaskName)
        if (([xml][string]$task.Xml).OuterXml -cne ([xml]$Context.RollbackTaskDefinition).OuterXml -or
            $task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
            [string]$task.GetSecurityDescriptor(7) -cne $Context.SecurityDescriptor) {
            throw 'Restored inactive task differs from original stopped policy.'
        }
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
        $Context.RollbackTaskReceipt = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control 'inactive-rollback-task-restored.json'),
            (Get-AgentsChatInactiveRollbackTaskText $Context 'task-restored'))
        $Context.Files.Add($Context.RollbackTaskReceipt)
        $Context.RollbackTaskComplete = $true
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{
        status='task-restored'; taskName=$Context.TaskName; priorRuntime='stopped'
        file=(Join-Path $Context.Control 'inactive-rollback-task-restored.json')
        sha256=$Context.RollbackTaskReceipt.Sha256
    }
}
