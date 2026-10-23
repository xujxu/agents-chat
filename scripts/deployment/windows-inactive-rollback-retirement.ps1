. (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')

function Publish-AgentsChatInactiveRollbackRetirementIntent([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ExclusiveLostRuntime -or -not $Context.RollbackPublished -or
        -not $Context.RollbackTaskComplete -or -not $Context.ContainsKey('RollbackCompletionReceipt')) {
        throw 'Stopped task retirement requires original exclusive completed rollback.'
    }
    $path = Join-Path $Context.Control 'inactive-rollback-retirement.json'
    if ($Context.ContainsKey('RollbackRetirementIntent')) {
        return [pscustomobject]@{ file=$path; sha256=$Context.RollbackRetirementIntent.Sha256 }
    }
    $names = [string[]]@($Context.Inventory)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($name in $names) {
        $relative = Join-Path 'task-maintenance' $name
        if ($name -ceq 'inactive-complete-release-requested.json') {
            $file = $Context.ReleaseIntentFile
            $file.Check()
            $identity = $file.CaptureIdentity()
            $entries.Add([ordered]@{
                path=$relative; dev=$identity.Dev; ino=$identity.Ino; bytes=$file.ByteLength; sha256=$file.Sha256
            })
        } else {
            $entries.Add((Get-AgentsChatRetirementFile $Context $relative))
        }
    }
    $record = [ordered]@{
        version=1; phase='task-retirement-prepared'; control=$Context.Control; project=$Context.Project
        operationId=$Context.OperationId; taskName=$Context.TaskName
        priorRuntime='stopped'; restoredRuntime='stopped'
        stateSha256=$Context.RollbackPhysicalState.Sha256
        completionSha256=$Context.RollbackCompletionReceipt.Sha256
        taskReceiptSha256=$Context.RollbackTaskReceipt.Sha256
        directory=(Get-AgentsChatRetirementDirectory $Context $Context.Directory)
        entries=$entries.ToArray()
    }
    $text = $record | ConvertTo-Json -Depth 5 -Compress
    if (Test-Path -LiteralPath $path) {
        $held = Open-AgentsChatCompletionFile $Context $path ''
    } else {
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
        $held = [Deployment.WindowsPrivateFile]::Publish($path, $text)
        $Context.Files.Add($held)
    }
    if ($held.ReadText() -cne $text) { throw 'Stopped task retirement intent differs from original file identities.' }
    $Context.RollbackRetirementIntent = $held
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$path; sha256=$held.Sha256 }
}
