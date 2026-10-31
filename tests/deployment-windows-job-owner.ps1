param(
    [Parameter(Mandatory)][string]$HelperRoot,
    [Parameter(Mandatory)][string]$Node
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $HelperRoot 'WindowsWorkerJob.cs')
$job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
$launcher = $null
try {
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File',
        (Join-Path $HelperRoot 'windows-worker-launcher.ps1'),
        '-JobName', $job.Name, '-OwnerPid', "$PID", '-OwnerIdentity', $job.OwnerIdentity)) {
        $info.ArgumentList.Add($arg)
    }
    $launcher = [Diagnostics.Process]::Start($info)
    $diagnostics = $launcher.StandardError.ReadToEndAsync()
    $ready = $launcher.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(30000)) { throw 'Owner fixture readiness timeout.' }
    $line = $ready.GetAwaiter().GetResult()
    if (-not $line) { throw ("Owner launcher failed: " + $diagnostics.GetAwaiter().GetResult()) }
    $frame = $line | ConvertFrom-Json
    if ($frame.type -ne 'ready' -or @($job.Members()) -notcontains $launcher.Id) {
        throw 'Owner fixture launcher is uncontained.'
    }
    $command = @{
        file=$Node
        args=@('-e', 'const fs=require("node:fs");fs.writeFileSync("owner-writer","x");setInterval(()=>fs.appendFileSync("owner-writer","x"),10);')
        cwd=$HelperRoot
        env=@{ PATH=$env:PATH; SystemRoot=$env:SystemRoot }
    }
    $launcher.StandardInput.WriteLine((@{type='run';command=$command} | ConvertTo-Json -Depth 8 -Compress))
    $launcher.StandardInput.Flush()
    $marker = Join-Path $HelperRoot 'owner-writer'
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path $marker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
    if (-not (Test-Path $marker)) { throw 'Owner fixture target did not start.' }
    $members = @($job.Members() | ForEach-Object {
        @{pid=$_;identity=[Deployment.WindowsWorkerJob]::ProcessIdentity([int]$_)}
    })
    [Console]::Out.WriteLine((@{type='ready';name=$job.Name;members=$members} | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Out.Flush()
    [Threading.Thread]::Sleep([Threading.Timeout]::Infinite)
} finally {
    $job.Dispose()
    if ($launcher) { $launcher.WaitForExit(15000) | Out-Null; $launcher.Dispose() }
}
