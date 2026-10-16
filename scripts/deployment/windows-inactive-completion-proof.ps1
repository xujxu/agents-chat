. (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
. (Join-Path $PSScriptRoot 'windows-guarded-task-policy.ps1')
. (Join-Path $PSScriptRoot 'windows-inactive-completion-records.ps1')

function Assert-AgentsChatInactiveCompletionHistory([hashtable]$Context) {
    $Context.Stage = 'inactive-inventory'
    if (Test-Path -LiteralPath (Join-Path $Context.Control 'recovery-lock')) { throw 'Exclusive recovery authority exists.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Context.Inventory) { $null = $expected.Add($name) }
    foreach ($entry in Get-ChildItem -LiteralPath $Context.Directory -Force) {
        if ($entry.PSIsContainer -or -not $expected.Remove($entry.Name)) { throw 'Foreign inactive completion evidence.' }
    }
    if ($expected.Count) { throw 'Missing inactive completion evidence.' }
    $Context.Stage = 'inactive-original-processes'
    $admission = $Context.Admission
    Assert-AgentsChatCompletionProcessAbsent $admission.controllerPid.GetInt32() $admission.controllerIdentity.GetString()
    Assert-AgentsChatCompletionProcessAbsent $Context.BridgePid $Context.BridgeIdentity
    $old = $Context.RetiredRuntime
    Assert-AgentsChatCompletionProcessAbsent $old.pid $old.identity
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$old.generation, $old.sessionId)
    $bundle = [IO.Path]::GetDirectoryName($admission.configuration.GetString())
    $entries = @(Get-ChildItem -LiteralPath $bundle -Force | Where-Object Name -Match '^(runtime|launch)-.*\.json$')
    if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or
        $entries[0].Name -cne "runtime-$($old.identity.Replace(':', '-')).json") {
        throw 'Original inactive runtime history changed.'
    }
}

function Assert-AgentsChatInactiveCompletionProof([hashtable]$Context) {
    if ($Context.Closed -or $Context.Poisoned -or $Context.Busy) { throw 'Inactive completion proof is unavailable.' }
    $Context.Busy = $true
    try {
        Assert-AgentsChatInactiveCompletionHistory $Context
        $Context.Stage = 'inactive-retained-evidence'
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatCompletionRuntime $Context
        foreach ($file in $Context.Files) { $file.Check() }
        Assert-AgentsChatInactiveCompletionHistory $Context
        Assert-AgentsChatCompletionFinalRuntime $Context
        return [pscustomobject][ordered]@{
            status='observed'; mutationAuthority=$false; operationId=$Context.OperationId; taskName=$Context.TaskName
            stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
            runtime=[pscustomobject]$Context.Runtime; port=$Context.Port; providers=$Context.Providers; lease='released'
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new("Inactive completion proof refused: $($Context.Stage).", $_.Exception)
    } finally { $Context.Busy = $false }
}

function Open-AgentsChatInactiveCompletionProof([string]$Control) {
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $context = @{
        Control=$Control; Directory=(Join-Path $Control 'task-maintenance')
        Files=[Collections.Generic.List[IDisposable]]::new()
        Closed=$false; Poisoned=$false; Busy=$false; Owner=$null; Instance=$null; Folder=$null; Stage='input'
    }
    try {
        if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows -or
            $Control -cnotmatch '^[A-Za-z]:\\' -or $Control -match '[\x00\r\n]' -or
            $Control.Length -gt 4096 -or [IO.Path]::GetFullPath($Control) -cne $Control) {
            throw 'Inactive completion requires a canonical Windows control path.'
        }
        foreach ($directory in @($Control, (Join-Path $Control 'lock'), $context.Directory)) {
            $context.Files.Add([Deployment.WindowsPrivateFile]::OpenDirectory($directory))
        }
        Read-AgentsChatInactiveCompletionRecords $context
        Assert-AgentsChatInactiveCompletionHistory $context
        $completed = $context.Completed
        $runtime = ConvertFrom-AgentsChatCompletionRuntime $completed.runtime.GetRawText()
        if ($runtime.generation -ceq $context.RetiredRuntime.generation -or
            $runtime.identity -ceq $context.RetiredRuntime.identity -or
            $runtime.configurationSha256 -cne $context.ConfigurationSha256) { throw 'Inactive completed runtime scope differs.' }
        $context.Runtime = $runtime
        $context.Port = $completed.port.GetInt32()
        if ($context.Port -lt 1 -or $context.Port -gt 65535 -or
            $completed.providers.GetArrayLength() -lt 1 -or $completed.providers.GetArrayLength() -gt 3) {
            throw 'Invalid inactive completion readiness.'
        }
        $context.Providers = [string[]]@($completed.providers.EnumerateArray() | ForEach-Object { $_.GetString() })
        if (@($context.Providers | Select-Object -Unique).Count -ne $context.Providers.Count -or
            @($context.Providers | Where-Object { $_ -cnotin @('admin-login', 'azure-ad', 'github') }).Count) {
            throw 'Unsupported inactive completion providers.'
        }
        $admission = $context.Admission
        Open-AgentsChatCompletionBundle $context $admission.configuration.GetString() `
            $admission.configurationSha256.GetString() $context.RetiredRuntime
        Open-AgentsChatCompletionBundle $context $context.Configuration $context.ConfigurationSha256 $runtime
        Initialize-AgentsChatCompletionLiveRuntime $context $completed
        if ($context.NativeEnabled -or
            ([xml]$context.NativeDefinition).OuterXml -cne ([xml]$context.Definition).OuterXml) {
            throw 'Inactive completion permanent policy changed.'
        }
        $null = Assert-AgentsChatInactiveCompletionProof $context
        return $context
    } catch {
        $failure = [InvalidOperationException]::new("Inactive completion proof open refused: $($context.Stage).", $_.Exception)
        try { Close-AgentsChatTaskCompletionProof $context }
        catch { throw [AggregateException]::new('Inactive proof open and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
