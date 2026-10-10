function Assert-AgentsChatFirstActivationState([hashtable]$Context) {
    if (-not $Context.ActivationPrepared) { return }
    $file = Join-Path $Context.Control 'state.json'
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
    try {
        if ($retained.ByteLength -gt 65536) { throw 'Oversized first-activation state.' }
        if ($null -ne $Context.ActivatingStateSha256) {
            if ($hash -cne $Context.ActivatingStateSha256) { throw 'Observed first-activation state changed.' }
            return
        }
        if ($hash -ceq $Context.StateSha256) { return }
        $original = $Context.OriginalState
        $current = Read-AgentsChatMaintenanceFields ($retained.ReadText()) ([string[]]@($original.Keys))
        foreach ($name in $original.Keys) {
            if ($name -cin @('phase', 'previousPhase', 'updatedAt')) { continue }
            if ($current[$name].GetRawText() -cne $original[$name].GetRawText()) {
                throw "First-activation state identity differs: $name."
            }
        }
        $updated = $current.updatedAt.GetString()
        $parsed = [DateTimeOffset]::MinValue
        if ($current.phase.GetString() -cne 'activating' -or $current.previousPhase.GetString() -cne 'configuring' -or
            -not [DateTimeOffset]::TryParseExact($updated, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
            throw 'First activation requires the exact configuring successor.'
        }
        $retained.Check()
        $Context.ActivatingStateSha256 = $hash
    } finally { $retained.Dispose() }
}

function Prepare-AgentsChatFirstActivation([hashtable]$Context, [hashtable]$Task) {
    if ($Context.ActivationPrepared -or $null -eq $Task) { throw 'First activation requires an original prepared task.' }
    Assert-AgentsChatFirstTaskRegistration $Task
    $Context.ConfiguringStateFile.Check()
    $registered = $Task.Observation
    $receipt = [ordered]@{
        status='first-activation-prepared'; runtimeAuthority=$false
        project=$Context.Project; operationId=$Context.OperationId; taskName=$Context.TaskName
        controllerPid=$PID; controllerIdentity=$Context.Identity
        lockSha256=$Context.LockSha256; configuringStateSha256=$Context.StateSha256
        configuration=$Context.Bundle.Configuration; configurationSha256=$Context.Bundle.Sha256
        taskFileSha256=$registered.taskFileSha256
    }
    $directory = Join-Path $Context.Control "first-task-$($Context.OperationId)"
    $null = Retain-AgentsChatFirstTaskResource $Context ([Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $directory 'activation-prepared.json'), ($receipt | ConvertTo-Json -Depth 4 -Compress)))
    $Context.ConfiguringStateFile.Check()
    $Context.ConfiguringStateFile.Dispose()
    $null = $Context.Checks.Remove($Context.ConfiguringStateFile)
    $null = $Context.Resources.Remove($Context.ConfiguringStateFile)
    $Context.ActivationPrepared = $true
    Assert-AgentsChatFirstActivationState $Context
    return $receipt
}
