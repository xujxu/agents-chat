# Shared launcher for scripts\{deploy,update,restore}.ps1: maps common options and runs core.mjs.
function Invoke-DeployCore {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][hashtable]$Bound,
        [string[]]$Extra = @()
    )
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Write-Error 'Node.js 24 was not found on PATH.'; exit 2 }

    $map = [ordered]@{
        ProjectDir = '--project-dir'; Revision = '--revision'; Port = '--port'; TaskName = '--service-name'
        NoInstall = '--no-install'; DryRun = '--dry-run'; Json = '--json'
    }
    $cliArgs = @($Command)
    foreach ($name in $map.Keys) {
        if (-not $Bound.ContainsKey($name)) { continue }
        $value = $Bound[$name]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $cliArgs += $map[$name] }
        } elseif ("$value") {
            $cliArgs += @($map[$name], "$value")
        }
    }
    if ($Bound['NoWait']) { $cliArgs += @('--wait', '0') }
    elseif ($Bound.ContainsKey('WaitSeconds')) { $cliArgs += @('--wait', "$($Bound['WaitSeconds'])") }
    $cliArgs += $Extra

    & $node.Source (Join-Path $PSScriptRoot 'core.mjs') @cliArgs
    exit $LASTEXITCODE
}
