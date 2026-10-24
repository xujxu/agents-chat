. (Join-Path $PSScriptRoot 'windows-task-retirement-records.ps1')

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

function Get-AgentsChatRuntimeHandoffReleaseText([hashtable]$Context, [string]$PreparedSha256) {
    return ([ordered]@{
        version=1; phase='runtime-evidence-released'; operationId=$Context.OperationId
        stateSha256=$Context.StateSha256; completionSha256=$Context.CompletionSha256
        preparedSha256=$PreparedSha256
    } | ConvertTo-Json -Compress)
}

function Get-AgentsChatRuntimeHandoffMembers([string]$Text, [string]$Sha256, [hashtable]$Runtime) {
    $document = [Text.Json.JsonDocument]::Parse($Text)
    try {
        $hashes = $document.RootElement.GetProperty('helpers')
        $members = [ordered]@{}
        foreach ($name in [Deployment.WindowsRuntimeHost]::HelperFiles) {
            $members[$name] = $hashes.GetProperty($name).GetString()
        }
        $members['configuration.json'] = $Sha256
        $members["runtime-$($Runtime.identity.Replace(':', '-')).json"] = $Runtime.readySha256
        return $members
    } finally { $document.Dispose() }
}

function Open-AgentsChatRuntimeHandoffArchive([hashtable]$Context) {
    $path = Join-Path $Context.Control 'inactive-rollback-runtime-handoff.json'
    $prepared = Open-AgentsChatCompletionFile $Context $path ''
    $record = Read-AgentsChatRetirementJson ($prepared.ReadText())
    $fields = @('version', 'phase', 'operationId', 'project', 'taskName', 'stateSha256',
        'completionSha256', 'configuration', 'configurationSha256', 'generation',
        'runtimeIdentity', 'readySha256', 'directoryIdentity', 'entries')
    Assert-AgentsChatRetirementFields $record $fields
    foreach ($name in $fields | Where-Object { $_ -cnotin @('version', 'entries', 'directoryIdentity') }) {
        if ($record[$name] -isnot [string]) { throw 'Invalid runtime handoff binding type.' }
    }
    if ($record.version -isnot [int] -or $record.version -ne 1 -or
        $record.phase -cne 'runtime-evidence-prepared' -or
        $record.operationId -cne $Context.OperationId -or $record.project -cne $Context.Project -or
        $record.taskName -cne $Context.TaskName -or $record.stateSha256 -cne $Context.StateSha256 -or
        $record.completionSha256 -cne $Context.CompletionSha256 -or
        $record.configuration -cne $Context.Admission.configuration.GetString() -or
        $record.configurationSha256 -cne $Context.Admission.configurationSha256.GetString() -or
        $record.generation -cne $Context.RetiredRuntime.generation -or
        $record.runtimeIdentity -cne $Context.RetiredRuntime.identity -or
        $record.readySha256 -cne $Context.RetiredRuntime.readySha256) {
        throw 'Runtime handoff differs from original stopped evidence.'
    }
    $relative = 'inactive-rollback-runtime-evidence'
    $directory = Join-Path $Context.Control $relative
    Open-AgentsChatRetirementDirectory $Context $directory $record.directoryIdentity
    $configuration = Join-Path $directory 'configuration.json'
    $file = Open-AgentsChatCompletionFile $Context $configuration $record.configurationSha256
    $members = Get-AgentsChatRuntimeHandoffMembers ($file.ReadText()) $record.configurationSha256 $Context.RetiredRuntime
    $names = [string[]]@($members.Keys)
    [Array]::Sort($names, [StringComparer]::Ordinal)
    if ($record.entries -isnot [array] -or $record.entries.Count -ne $names.Count) {
        throw 'Runtime handoff archive descriptor inventory differs.'
    }
    Assert-AgentsChatRuntimeHandoffInventory $directory $names -Complete
    for ($index = 0; $index -lt $names.Count; $index++) {
        $entry = $record.entries[$index]
        $name = $names[$index]
        $null = Open-AgentsChatRetirementFile $Context $entry (Join-Path $relative $name)
        if ($entry.sha256 -cne $members[$name]) { throw 'Runtime handoff archive digest differs.' }
    }
    Open-AgentsChatCompletionBundle $Context $configuration $record.configurationSha256 $Context.RetiredRuntime
    $Context.RuntimeHandoffDirectory = $directory
    $Context.RuntimeHandoffNames = $names
    $releasedPath = Join-Path $Context.Control 'inactive-rollback-runtime-released.json'
    if (Test-Path -LiteralPath $releasedPath) {
        $released = Open-AgentsChatCompletionFile $Context $releasedPath ''
        if ($released.ReadText() -cne (Get-AgentsChatRuntimeHandoffReleaseText $Context $prepared.Sha256)) {
            throw 'Runtime handoff release differs from its exact prepared checkpoint.'
        }
        $Context.RuntimeHandoffReleased = $true
        $Context.RuntimeHandoffReleaseFile = $released
    }
    return $prepared
}

function Release-AgentsChatInactiveRollbackRuntimeHandoff([hashtable]$Context) {
    $null = Publish-AgentsChatInactiveRollbackRuntimeHandoff $Context
    $prepared = Open-AgentsChatRuntimeHandoffArchive $Context
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    $path = Join-Path $Context.Control 'inactive-rollback-runtime-released.json'
    if (-not $Context.ContainsKey('RuntimeHandoffReleased')) {
        $released = [Deployment.WindowsPrivateFile]::Publish(
            $path, (Get-AgentsChatRuntimeHandoffReleaseText $Context $prepared.Sha256))
        $Context.Files.Add($released)
        $Context.RuntimeHandoffReleaseFile = $released
        $Context.RuntimeHandoffReleased = $true
    }
    # The durable release must exist before the last original source handle disappears.
    for ($index = $Context.RetiredBundleFiles.Count - 1; $index -ge 0; $index--) {
        $resource = $Context.RetiredBundleFiles[$index]
        $resource.Dispose()
        $null = $Context.Files.Remove($resource)
    }
    $Context.RetiredBundleFiles.Clear()
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$path; sha256=$Context.RuntimeHandoffReleaseFile.Sha256 }
}

function Publish-AgentsChatInactiveRollbackRuntimeHandoff([hashtable]$Context) {
    $null = Publish-AgentsChatInactiveRollbackIntent $Context
    if ($Context.ContainsKey('RuntimeHandoffReleased')) {
        $prepared = Open-AgentsChatRuntimeHandoffArchive $Context
        $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
        return [pscustomobject]@{
            file=(Join-Path $Context.Control 'inactive-rollback-runtime-handoff.json'); sha256=$prepared.Sha256
        }
    }
    $configuration = $Context.Admission.configuration.GetString()
    $configurationSha256 = $Context.Admission.configurationSha256.GetString()
    $source = [IO.Path]::GetDirectoryName($configuration)
    $configurationFile = Open-AgentsChatCompletionFile $Context $configuration $configurationSha256
    $Context.RetiredBundleFiles.Add($configurationFile)
    $members = Get-AgentsChatRuntimeHandoffMembers ($configurationFile.ReadText()) $configurationSha256 $Context.RetiredRuntime
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
            $sourceFile = if ($name -ceq 'configuration.json') { $configuration } else { Join-Path $source $name }
            $copy = [Deployment.WindowsPrivateFile]::CopyTrustedSource(
                $sourceFile, $members[$name], (Join-Path $directory $name))
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
    $Context.RuntimeHandoffDirectory = $directory
    $Context.RuntimeHandoffNames = $names
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{ file=$path; sha256=$receipt.Sha256 }
}
