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
$api = $null
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
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('SystemRoot', 'TEMP', 'TMP')) {
        $environment.Add($name, [Environment]::GetEnvironmentVariable($name))
    }
    $api = [Deployment.WindowsControllerProcess]::Start($Node, [string[]]@(
        (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs'), 'restored', $ChatId, 'wait-ready'),
        $PSScriptRoot, $environment)
    $output = $api.StandardOutput.ReadToEndAsync()
    $diagnostic = $api.StandardError.ReadToEndAsync()
    if (-not $api.WaitForExit(135000)) { throw 'Original unacknowledged application API verification exceeded its deadline.' }
    if (-not $output.Wait(15000) -or -not $diagnostic.Wait(15000)) { throw 'Cold launch API streams did not settle.' }
    $errorText = $diagnostic.GetAwaiter().GetResult()
    if ($errorText) { [Console]::Error.Write($errorText) }
    if ($api.ExitCode -ne 0 -or
        $output.GetAwaiter().GetResult().Trim() -cne 'PASS: managed Windows application API restored') {
        throw 'Original unacknowledged application did not preserve authenticated data.'
    }
    $listener.Check()
    Write-Output (@{ status='ready'; generation=$Generation.ToString('D'); port=3010 } | ConvertTo-Json -Compress)
} finally {
    try {
        if ($api) {
            try {
                if (-not $api.HasExited) {
                    $api.Kill()
                    if (-not $api.WaitForExit(15000)) { throw 'Cold launch API process cleanup failed.' }
                }
            } finally { $api.Dispose() }
        }
    } finally { if ($listener) { $listener.Dispose() } }
}
