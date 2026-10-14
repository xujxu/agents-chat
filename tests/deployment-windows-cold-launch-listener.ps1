param(
    [Parameter(Mandatory)][guid]$Generation,
    [Parameter(Mandatory)][int]$OwnerPid,
    [Parameter(Mandatory)][string]$OwnerIdentity,
    [Parameter(Mandatory)][int]$LauncherPid,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$ChatId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helpers = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs', 'WindowsControllerCapture.cs', 'WindowsRuntimeDomain.cs',
    'WindowsRuntimePipe.cs', 'WindowsRuntimeControl.cs', 'WindowsRuntimeListener.cs' |
    ForEach-Object { Join-Path $helpers $_ })
$listener = $null
$deadline = [Diagnostics.Stopwatch]::StartNew()
try {
    while (-not $listener) {
        try {
            $listener = [Deployment.WindowsRuntimeListener]::Retain(
                $Generation, $OwnerPid, $OwnerIdentity, $LauncherPid, 3010)
        } catch {
            if ($_.Exception.GetBaseException() -isnot [Deployment.WindowsRuntimeListenerNotReadyException]) { throw }
            if ($deadline.ElapsedMilliseconds -ge 120000) { throw 'Original cold launch listener did not become ready.' }
            Start-Sleep -Milliseconds 100
        }
    }
    $listener.Check()
    $null = & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId wait-ready
    if ($LASTEXITCODE -ne 0) { throw 'Original unacknowledged application did not preserve authenticated data.' }
    $listener.Check()
    Write-Output (@{ status='ready'; generation=$Generation.ToString('D'); port=3010 } | ConvertTo-Json -Compress)
} finally {
    if ($listener) { $listener.Dispose() }
}
