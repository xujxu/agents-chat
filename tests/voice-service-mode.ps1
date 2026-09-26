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
$root = Join-Path ([IO.Path]::GetTempPath()) ('service-mode-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
Push-Location
try {
    Copy-Item (Join-Path $PSScriptRoot '..\scripts\service-watchdog.ps1') (Join-Path $root 'scripts\service-watchdog.ps1')
    [IO.File]::WriteAllText((Join-Path $root 'scripts\start.ps1'), '')
    function Get-NetTCPConnection { return @() }
    function Start-Process {
        param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
        if ($ArgumentList -notcontains '-NoTunnel') { throw 'Missing child local mode.' }
        if ($env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Token inherited by child.' }
        New-Item -ItemType File -Path (Join-Path $WorkingDirectory '.service-stop') -Force | Out-Null
        return [pscustomobject]@{Id=42;HasExited=$true;ExitCode=0}
    }
    $savedGh = $env:GH_TOKEN
    $savedGithub = $env:GITHUB_TOKEN
    $env:GH_TOKEN = 'non-secret-isolation-sentinel'
    $env:GITHUB_TOKEN = 'non-secret-isolation-sentinel'
    & (Join-Path $root 'scripts\service-watchdog.ps1') -NoTunnel
    if (-not (Test-Path (Join-Path $root '.service-stop'))) { throw 'Watchdog never launched child.' }
} finally {
    Pop-Location
    $env:GH_TOKEN = $savedGh
    $env:GITHUB_TOKEN = $savedGithub
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Host 'Task no-tunnel mode contracts passed.'
