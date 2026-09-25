$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\voice\windows\task-mode.ps1')
function Assert-Mode($Arguments, $Explicit, $Requested, $Expected) {
    $task = if ($null -eq $Arguments) { $null } else {
        [pscustomobject]@{ Actions = @([pscustomobject]@{Arguments=$Arguments}) }
    }
    $actual = Get-TaskNoTunnelMode -Task $task -Explicit $Explicit -Requested $Requested
    if ($actual -ne $Expected) { throw "Unexpected mode: $Arguments / $Explicit / $Requested" }
}
Assert-Mode $null $false $false $false
Assert-Mode '-File "C:\app\watchdog.ps1" -NoTunnel' $false $false $true
Assert-Mode '-File "C:\app\watchdog.ps1" -NoTunnel' $true $false $false
Assert-Mode '-File "C:\app\watchdog.ps1"' $true $true $true
Assert-Mode '-File "C:\a -NoTunnel dir\watchdog.ps1"' $false $false $false
Write-Host 'Task no-tunnel mode contracts passed.'
