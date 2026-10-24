param(
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)][string]$Directory,
    [switch]$Archived,
    [switch]$ResumeExisting,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resources = [Collections.Generic.List[IDisposable]]::new()
$copies = [Collections.Generic.List[IDisposable]]::new()
$failure = $null
$stage = 'bootstrap'
function Assert-RuntimePublicationInventory([bool]$Complete) {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in [Deployment.WindowsRuntimeHost]::HelperFiles) { $null = $names.Add($name) }
    $null = $names.Add('configuration.json')
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.PSIsContainer -or -not $names.Remove($item.Name)) {
            throw 'Runtime destination contains foreign or duplicate members.'
        }
    }
    if ($Complete -and $names.Count) { throw 'Runtime destination is incomplete.' }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported runtime publisher.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $stage = 'controller'
    $resources.Add([Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity))
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $stage = 'source'
    $source = [IO.Path]::GetDirectoryName($Configuration)
    $sourceDirectory = [Deployment.WindowsPrivateFile]::OpenDirectory($source)
    $resources.Add($sourceDirectory)
    $configurationFile = [Deployment.WindowsPrivateFile]::Open($Configuration, $Sha256)
    $resources.Add($configurationFile)
    $document = [Text.Json.JsonDocument]::Parse($configurationFile.ReadText())
    $resources.Add($document)
    $hashes = $document.RootElement.GetProperty('helpers')
    $sources = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    if ($Archived) {
        $stage = 'archive-input'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method', 'files')
        if ($request.id.GetInt32() -ne 0 -or $request.method.GetString() -cne 'archive' -or
            $request.files.ValueKind -ne [Text.Json.JsonValueKind]::Array -or
            $request.files.GetArrayLength() -ne [Deployment.WindowsRuntimeHost]::HelperFiles.Length + 1) {
            throw 'Unexpected archived runtime inventory.'
        }
        $configurationSeen = $false
        foreach ($item in $request.files.EnumerateArray()) {
            $fields = Read-AgentsChatMaintenanceFields ($item.GetRawText()) @('name', 'file', 'sha256')
            $name = $fields.name.GetString()
            $file = $fields.file.GetString()
            $digest = $fields.sha256.GetString()
            if ([IO.Path]::GetDirectoryName($file) -cne $source) { throw 'Archived runtime member directory differs.' }
            if ($name -ceq 'configuration.json') {
                if ($configurationSeen -or $file -cne $Configuration -or $digest -cne $Sha256) {
                    throw 'Archived runtime configuration differs.'
                }
                $configurationSeen = $true
            } else {
                if ($name -cnotin [Deployment.WindowsRuntimeHost]::HelperFiles -or
                    $digest -cne $hashes.GetProperty($name).GetString()) { throw 'Archived helper differs.' }
                $sources.Add($name, $file)
            }
        }
        if (-not $configurationSeen) { throw 'Archived runtime configuration is absent.' }
        $original = [Deployment.WindowsRuntimeHost]::OpenArchive($Configuration, $Sha256, $sources)
    } else {
        $original = [Deployment.WindowsRuntimeHost]::Open($Configuration, $Sha256, $source)
        foreach ($name in [Deployment.WindowsRuntimeHost]::HelperFiles) { $sources.Add($name, (Join-Path $source $name)) }
    }
    $resources.Add($original)
    $stage = 'private-destination'
    $destination = if ($ResumeExisting -and (Test-Path -LiteralPath $Directory)) {
        [Deployment.WindowsPrivateFile]::OpenDirectory($Directory)
    } else { [Deployment.WindowsPrivateFile]::CreateDirectory($Directory) }
    $resources.Add($destination)
    $existing = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    Assert-RuntimePublicationInventory $false
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        $digest = if ($item.Name -ceq 'configuration.json') { $Sha256 } else { $hashes.GetProperty($item.Name).GetString() }
        $held = [Deployment.WindowsPrivateFile]::Open($item.FullName, $digest)
        $resources.Add($held)
        $copies.Add($held)
        $null = $existing.Add($item.Name)
    }
    $stage = 'copy'
    foreach ($name in [Deployment.WindowsRuntimeHost]::HelperFiles) {
        $sourceDirectory.Check()
        $original.Check()
        $destination.Check()
        if ($existing.Contains($name)) { continue }
        $copy = [Deployment.WindowsPrivateFile]::CopyTrustedSource(
            $sources[$name], $hashes.GetProperty($name).GetString(), (Join-Path $Directory $name))
        $resources.Add($copy)
        $copies.Add($copy)
    }
    $publishedConfiguration = Join-Path $Directory 'configuration.json'
    if (-not $existing.Contains('configuration.json')) {
        $copy = [Deployment.WindowsPrivateFile]::CopyTrustedSource($Configuration, $Sha256, $publishedConfiguration)
        $resources.Add($copy)
        $copies.Add($copy)
    }
    $stage = 'destination-validation'
    $published = [Deployment.WindowsRuntimeHost]::Open($publishedConfiguration, $Sha256, $Directory)
    $resources.Add($published)
    foreach ($file in $copies) { $file.Check() }
    $sourceDirectory.Check()
    $original.Check()
    $destination.Check()
    Assert-RuntimePublicationInventory $true
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        directory=$Directory; configuration=$publishedConfiguration; sha256=$Sha256
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $stage = 'close'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
    $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
    if ($request.id.GetInt32() -ne 1 -or $request.method.GetString() -cne 'close' -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original runtime publisher close request differs.'
    }
    foreach ($file in $copies) { $file.Check() }
    $sourceDirectory.Check()
    $original.Check()
    $destination.Check()
    $published.Check()
    Assert-RuntimePublicationInventory $true
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Runtime publication refused: $stage. Retain any incomplete destination.")
} finally {
    $closing = $resources.ToArray()
    [array]::Reverse($closing)
    foreach ($resource in $closing) {
        try { $resource.Dispose() }
        catch {
            [Console]::Error.WriteLine('Runtime publication handle cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Runtime publication and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
[Console]::Out.WriteLine((@{ id=1; type='reply'; value='close'; processIdentity=$identity } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
