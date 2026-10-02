param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][int]$OwnerPid,
    [Parameter(Mandatory)][string]$OwnerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path $Source
$watch = [Deployment.WindowsWorkerLauncher]::WatchOwner($OwnerPid, $OwnerIdentity)
try {
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $Root)
    $environment.Add('TMP', $Root)
    $result = [Deployment.WindowsWorkerLauncher]::Run($Node, @((Join-Path $Root 'writer.cjs'), $Root), $Root, $environment)
    if ($result.exitCode -ne 0) { throw "Native owner writer failed: $($result.exitCode)" }
} finally { $watch.Dispose() }
