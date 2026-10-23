function Publish-AgentsChatInactiveRollbackTerminal([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ContainsKey('ExclusiveLostRuntime') -or -not $Context.ExclusiveLostRuntime -or
        -not $Context.ContainsKey('RollbackTaskComplete') -or -not $Context.RollbackTaskComplete -or
        -not $Context.ContainsKey('RollbackFilesReceipt') -or -not $Context.ContainsKey('RollbackIntent')) {
        throw 'Stopped terminal handoff requires original exclusive completed rollback evidence.'
    }
    $path = Join-Path $Context.Control 'inactive-rollback-terminal.json'
    if ($Context.ContainsKey('RollbackTerminal')) {
        $Context.RollbackTerminal.Check()
        return [pscustomobject]@{ file=$path; sha256=$Context.RollbackTerminal.Sha256 }
    }
    $state = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $Context.StateSha256
    $identity = $state.CaptureIdentity()
    $task = $Context.RollbackTaskReceipt.ReadText() | ConvertFrom-Json
    $intent = $Context.RollbackIntent.ReadText() | ConvertFrom-Json
    $record = [ordered]@{
        version=1; phase='terminal-prepared'; project=$Context.Project; operationId=$Context.OperationId
        taskName=$Context.TaskName; stateSha256=$Context.StateSha256
        oldState=$state.ReadText(); sourceCommit=$intent.sourceCommit
        priorRuntime='stopped'; restoredRuntime='stopped'
        rollbackIntentSha256=$Context.RollbackIntent.Sha256
        filesReceiptSha256=$Context.RollbackFilesReceipt.Sha256
        taskIntentSha256=$Context.RollbackTaskIntent.Sha256
        taskReceiptSha256=$Context.RollbackTaskReceipt.Sha256
        runtimeBundle=$task.runtimeBundle
        stateIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino; bytes=$state.ByteLength }
    }
    $text = $record | ConvertTo-Json -Depth 5 -Compress
    if (Test-Path -LiteralPath $path) {
        $held = Open-AgentsChatCompletionFile $Context $path ''
        if ($held.ReadText() -cne $text) { throw 'Stopped terminal handoff differs from its retained original evidence.' }
    } else {
        $held = [Deployment.WindowsPrivateFile]::Publish($path, $text)
        $Context.Files.Add($held)
    }
    $Context.RollbackTerminal = $held
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$path; sha256=$held.Sha256 }
}
