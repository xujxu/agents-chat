. (Join-Path $PSScriptRoot 'windows-task-replacement.ps1')

function Get-AgentsChatGuardedActivationDefinition([hashtable]$Context, [int]$ControllerPid,
    [string]$ControllerIdentity, [switch]$Permanent) {
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { $powershell = $process.MainModule.FileName }
    finally { $process.Dispose() }
    if ($Context.ContainsKey('PowerShell')) {
        if ($Context.PowerShell -isnot [string] -or
            -not [string]::Equals($Context.PowerShell, $powershell, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Cold policy reconstruction requires the original native interpreter path.'
        }
        $powershell = $Context.PowerShell
    }
    if ($powershell -match '%|\$\(' -or $Context.Configuration -match '%|\$\(') {
        throw 'Cold activation requires literal native runtime paths.'
    }
    $requested = [xml]$Context.Definition
    $namespaces = [Xml.XmlNamespaceManager]::new($requested.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $hostFile = Join-Path $Context.Bundle 'windows-runtime-host.ps1'
    $values = [ordered]@{
        Command=$powershell; WorkingDirectory=$Context.Bundle
        Arguments="-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($Context.Configuration)`" -Sha256 $($Context.ConfigurationSha256)"
    }
    if (-not $Permanent) { $values.Arguments += " -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity" }
    foreach ($name in $values.Keys) {
        $nodes = $requested.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
        if ($nodes.Count -ne 1) { throw 'Cold activation requires one literal native action.' }
        $nodes[0].InnerText = $values[$name]
    }
    Confirm-AgentsChatTaskReplacementPolicy $Context.Definition $requested.OuterXml $Context
    $triggers = $requested.SelectNodes('/t:Task/t:Triggers', $namespaces)
    $restart = $requested.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
    if ($triggers.Count -ne 1 -or $restart.Count -gt 1) { throw 'Unsupported cold task automation shape.' }
    if (-not $Permanent) {
        $triggers[0].IsEmpty = $true
        if ($restart.Count) { $null = $restart[0].ParentNode.RemoveChild($restart[0]) }
    }
    if ($requested.OuterXml.Length -gt 262144) { throw 'Cold activation policy exceeds its evidence budget.' }
    return $requested.OuterXml
}
