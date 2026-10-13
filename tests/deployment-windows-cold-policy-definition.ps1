$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-cold-activation-context.ps1')
$process = [Diagnostics.Process]::GetCurrentProcess()
try {
    $pwsh = $process.MainModule.FileName
    $identity = "$PID`:$($process.StartTime.ToUniversalTime().Ticks)"
} finally { $process.Dispose() }
$definition = '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Settings><Enabled>false</Enabled><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions><Exec><Command>original</Command><Arguments>original</Arguments><WorkingDirectory>original</WorkingDirectory></Exec></Actions></Task>'
$policy = @{
    Definition=$definition; Bundle='C:\fixture\bundle'
    Configuration='C:\fixture\bundle\configuration.json'; ConfigurationSha256=('a' * 64)
    Stage='fixture'
}
$recorded = $pwsh.ToUpperInvariant()
if ($recorded -ceq $pwsh) { $recorded = $pwsh.ToLowerInvariant() }
foreach ($permanent in @($false, $true)) {
    $expected = [xml](Get-AgentsChatColdActivationDefinition $policy $PID $identity -Permanent:$permanent)
    $ns = [Xml.XmlNamespaceManager]::new($expected.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $expected.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command', $ns).InnerText = $recorded
    $bound = $policy.Clone()
    $bound.PowerShell = $recorded
    $actual = Get-AgentsChatColdActivationDefinition $bound $PID $identity -Permanent:$permanent
    if ($actual -cne $expected.OuterXml) {
        throw 'Cold policy reconstruction lost the original executable spelling or changed unrelated policy.'
    }
    foreach ($foreign in @("$pwsh.foreign", (Join-Path ([IO.Path]::GetDirectoryName($pwsh)) '.\pwsh.exe'), '', $null)) {
        $bound.PowerShell = $foreign
        $refused = $false
        try { $null = Get-AgentsChatColdActivationDefinition $bound $PID $identity -Permanent:$permanent }
        catch { $refused = $true }
        if (-not $refused) { throw 'Cold policy reconstruction admitted an unbound interpreter path.' }
    }
}
Write-Output 'PASS: cold policy reconstruction preserves recorded executable casing only, with exact guarded and permanent policy'
