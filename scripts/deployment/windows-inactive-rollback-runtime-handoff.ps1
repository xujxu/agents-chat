function Assert-AgentsChatRuntimeHandoffInventory([string]$Directory, [string[]]$Names, [switch]$Complete) {
    $remaining = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $Names) { $null = $remaining.Add($name) }
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.PSIsContainer -or -not $remaining.Remove($item.Name)) {
            throw 'Runtime evidence archive contains foreign members.'
        }
    }
    if ($Complete -and $remaining.Count) { throw 'Runtime evidence archive is incomplete.' }
}

function Publish-AgentsChatInactiveRollbackRuntimeHandoff([hashtable]$Context) {
    $null = Publish-AgentsChatInactiveRollbackIntent $Context
    $configuration = $Context.Admission.configuration.GetString()
    $configurationSha256 = $Context.Admission.configurationSha256.GetString()
    $source = [IO.Path]::GetDirectoryName($configuration)
    $configurationFile = Open-AgentsChatCompletionFile $Context $configuration $configurationSha256
    $document = [Text.Json.JsonDocument]::Parse($configurationFile.ReadText())
    try {
        $hashes = $document.RootElement.GetProperty('helpers')
        $members = [ordered]@{}
        foreach ($name in [Deployment.WindowsRuntimeHost]::HelperFiles) {
            $members[$name] = $hashes.GetProperty($name).GetString()
        }
        $members['configuration.json'] = $configurationSha256
        $ready = "runtime-$($Context.RetiredRuntime.identity.Replace(':', '-')).json"
        $members[$ready] = $Context.RetiredRuntime.readySha256
    } finally { $document.Dispose() }
    $names = [string[]]@($members.Keys)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $relative = 'inactive-rollback-runtime-evidence'
    $directory = Join-Path $Context.Control $relative
    $path = Join-Path $Context.Control 'inactive-rollback-runtime-handoff.json'
    $prepared = Test-Path -LiteralPath $path
    if ($prepared -and -not (Test-Path -LiteralPath $directory)) {
        throw 'Prepared runtime evidence archive is absent.'
    }
    $destination = if (Test-Path -LiteralPath $directory) {
        [Deployment.WindowsPrivateFile]::OpenDirectory($directory)
    } else { [Deployment.WindowsPrivateFile]::CreateDirectory($directory) }
    $Context.Files.Add($destination)
    Assert-AgentsChatRuntimeHandoffInventory $directory $names -Complete:$prepared
    $existing = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        $held = [Deployment.WindowsPrivateFile]::Open($item.FullName, $members[$item.Name])
        $Context.Files.Add($held)
        $null = $existing.Add($item.Name)
    }
    foreach ($name in $names) {
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
        $destination.Check()
        if (-not $existing.Contains($name)) {
            $copy = [Deployment.WindowsPrivateFile]::CopyTrustedSource(
                (Join-Path $source $name), $members[$name], (Join-Path $directory $name))
            $Context.Files.Add($copy)
        }
    }
    Assert-AgentsChatRuntimeHandoffInventory $directory $names -Complete
    $entries = @($names | ForEach-Object {
        Get-AgentsChatRetirementFile $Context (Join-Path $relative $_)
    })
    $identity = $destination.CaptureIdentity()
    $record = [ordered]@{
        version=1; phase='runtime-evidence-prepared'; operationId=$Context.OperationId
        project=$Context.Project; taskName=$Context.TaskName
        stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
        configuration=$configuration; configurationSha256=$configurationSha256
        generation=$Context.RetiredRuntime.generation; runtimeIdentity=$Context.RetiredRuntime.identity
        readySha256=$Context.RetiredRuntime.readySha256
        directoryIdentity=[ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
        entries=$entries
    }
    $text = $record | ConvertTo-Json -Depth 6 -Compress
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if ($prepared) {
        $receipt = Open-AgentsChatCompletionFile $Context $path ''
        if ($receipt.ReadText() -cne $text) {
            throw 'Prepared runtime evidence archive differs from its original identities.'
        }
    } else {
        $receipt = [Deployment.WindowsPrivateFile]::Publish($path, $text)
        $Context.Files.Add($receipt)
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$path; sha256=$receipt.Sha256 }
}
