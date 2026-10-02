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
    $identityTools = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'
    if (-not (Test-Path -LiteralPath (Join-Path $identityTools 'powershell.exe') -PathType Leaf)) {
        throw 'Missing system Windows PowerShell for native process identity'
    }
    $environment.Add('PATH', $identityTools)
    $result = [Deployment.WindowsWorkerLauncher]::Run($Node, @((Join-Path $Root 'writer.cjs'), $Root), $Root, $environment)
    if ($result.exitCode -ne 0) {
        $diagnostic = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result.stderr))
        [IO.File]::WriteAllText((Join-Path $Root 'writer-error.txt'), $diagnostic.Substring([Math]::Max(0, $diagnostic.Length - 8192)))
        throw "Native owner writer failed: $($result.exitCode)"
    }
} finally { $watch.Dispose() }
