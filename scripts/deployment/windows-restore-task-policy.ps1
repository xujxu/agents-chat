param(
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$owner = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported restore policy observer.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs')
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')
    $stage = 'controller'
    $owner = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $policies = @()
    foreach ($id in @(1, 2)) {
        $stage = 'policy-input'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
        $fields = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method', 'definition', 'securityDescriptor')
        $definition = $fields.definition.GetString()
        $security = $fields.securityDescriptor.GetString()
        if ($fields.id.GetInt32() -ne $id -or $fields.method.GetString() -cne 'policy' -or
            [string]::IsNullOrEmpty($definition) -or $definition.Length -gt 262144 -or $definition.Contains([char]0) -or
            [string]::IsNullOrEmpty($security) -or $security.Length -gt 65536 -or $security -match '[\x00\r\n]') {
            throw 'Unexpected restore policy input.'
        }
        $policies += @{ definition=$definition; security=$security }
    }
    $stage = 'security'
    if ($policies[0].security -cne $policies[1].security) { throw 'Saved task security differs.' }
    $stage = 'enabled-policy'
    $current = [xml]($policies[0].definition)
    $saved = [xml]($policies[1].definition)
    $namespaces = [Xml.XmlNamespaceManager]::new($current.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $enabledValues = @()
    foreach ($document in @($current, $saved)) {
        $settings = $document.SelectNodes('/t:Task/t:Settings', $namespaces)
        $enabled = $document.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        if ($settings.Count -ne 1 -or $enabled.Count -gt 1 -or ($enabled.Count -eq 1 -and
            ($enabled[0].Attributes.Count -ne 0 -or $enabled[0].InnerXml -cnotin @('true', 'false')))) {
            throw 'Saved enabled policy is unsupported.'
        }
        # Scheduler omits Enabled for its default true, as in native completion.
        $enabledValues += ($enabled.Count -eq 0 -or $enabled[0].InnerText -ceq 'true')
        if ($enabled.Count) { $null = $settings[0].RemoveChild($enabled[0]) }
        $normalized = $document.CreateElement('Enabled', $namespaces.LookupNamespace('t'))
        $normalized.InnerText = 'false'
        $null = $settings[0].AppendChild($normalized)
    }
    if ($enabledValues[0] -ne $enabledValues[1]) { throw 'Saved enabled policy differs.' }
    $stage = 'permanent-policy'
    $context = @{ Stage=$stage }
    Confirm-AgentsChatTaskReplacementPolicy $current.OuterXml $saved.OuterXml $context
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity; value='same-task-policy'
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $stage = 'close'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
    $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
    if ($request.id.GetInt32() -ne 3 -or $request.method.GetString() -cne 'close' -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original restore policy close request differs.'
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Restore policy comparison refused: $stage.")
} finally {
    if ($owner) {
        try { $owner.Dispose() }
        catch {
            [Console]::Error.WriteLine('Restore policy observer cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Restore policy comparison and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
[Console]::Out.WriteLine((@{ id=3; type='reply'; value='close'; processIdentity=$identity } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
