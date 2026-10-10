function Assert-AgentsChatFirstActivationState([hashtable]$Context) {
    if (-not $Context.ActivationPrepared) { return }
    $file = Join-Path $Context.Control 'state.json'
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
    try {
        if ($retained.ByteLength -gt 65536) { throw 'Oversized first-activation state.' }
        if ($null -ne $Context.AcceptedStateSha256) {
            if ($hash -cne $Context.AcceptedStateSha256) { throw 'Observed first-acceptance state changed.' }
            return
        }
        $completing = $null -ne $Context.ActivatingStateSha256
        if ($completing) {
            if ($hash -ceq $Context.ActivatingStateSha256) { return }
            if (-not $Context.CompletionPrepared) { throw 'Observed first-activation state changed.' }
        } elseif ($hash -ceq $Context.StateSha256) { return }
        $original = if ($completing) { $Context.ActivatingStateFields } else { $Context.OriginalState }
        $phase = if ($completing) { 'accepted' } else { 'activating' }
        $previous = if ($completing) { 'activating' } else { 'configuring' }
        $current = Read-AgentsChatMaintenanceFields ($retained.ReadText()) ([string[]]@($original.Keys))
        foreach ($name in $original.Keys) {
            if ($name -cin @('phase', 'previousPhase', 'updatedAt')) { continue }
            if ($current[$name].GetRawText() -cne $original[$name].GetRawText()) {
                throw "First-activation state identity differs: $name."
            }
        }
        $updated = $current.updatedAt.GetString()
        $parsed = [DateTimeOffset]::MinValue
        if ($current.phase.GetString() -cne $phase -or $current.previousPhase.GetString() -cne $previous -or
            ($completing -and [string]::CompareOrdinal($updated, $original.updatedAt.GetString()) -lt 0) -or
            -not [DateTimeOffset]::TryParseExact($updated, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
            throw "First runtime requires the exact $previous successor."
        }
        $retained.Check()
        if ($completing) { $Context.AcceptedStateSha256 = $hash }
        else {
            $Context.ActivatingStateSha256 = $hash
            $Context.ActivatingStateFields = $current
        }
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
