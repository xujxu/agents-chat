param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$actor = $bridge = $runtime = $listener = $diagnostic = $null
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('PATH', $env:PATH)
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
try {
    $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
        (Join-Path $PSScriptRoot 'deployment-windows-cold-activation.mjs'), $Control,
        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, 'crash'), $Control, $environment)
    $diagnostic = $actor.StandardError.ReadToEndAsync()
    $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
    if (-not $frame.Wait(600000)) { throw 'Cold crash actor did not publish its admitted running runtime.' }
    $running = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
    $bridge = [Diagnostics.Process]::GetProcessById($running.controllerPid)
    $runtime = [Diagnostics.Process]::GetProcessById($running.runtime.pid)
    $null = $bridge.Handle
    $null = $runtime.Handle
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $running.controllerIdentity -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.Id) -cne $running.runtime.identity) {
        throw 'Cold crash fixture lost its original bridge or runtime identity.'
    }
    $state = Get-Content -LiteralPath (Join-Path $Control 'state.json') -Raw | ConvertFrom-Json
    $endpoint = Get-Content -LiteralPath (Join-Path $state.project 'listener.json') -Raw | ConvertFrom-Json
    $listener = [Diagnostics.Process]::GetProcessById($endpoint.pid)
    $null = $listener.Handle
    $runningFile = Join-Path $Control 'recovery-lock/activation-running.json'
    $runningHash = (Get-FileHash -LiteralPath $runningFile -Algorithm SHA256).Hash
    $bridge.Kill()
    if (-not $bridge.WaitForExit(15000)) { throw 'Original cold activation bridge survived forced termination.' }
    $actor.Kill()
    if (-not $actor.WaitForExit(15000)) { throw 'Original cold Node actor survived forced termination.' }
    if (-not $runtime.WaitForExit(60000) -or -not $listener.WaitForExit(15000)) {
        throw 'Guarded cold runtime or owned listener survived its original bridge death.'
    }
    if (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock/activation-stopped.json')) {
        throw 'Cold crash fixture unexpectedly published a normal stopped acknowledgement.'
    }
    if ((Get-FileHash -LiteralPath $runningFile -Algorithm SHA256).Hash -cne $runningHash) {
        throw 'Cold crash fixture changed its admitted running receipt.'
    }
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
        [guid]$running.runtime.generation, $running.runtime.sessionId)
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($scheduler.GetFolder('\').GetTask($running.taskName).GetInstances(0).Count -ne 0) {
        if ($deadline.ElapsedMilliseconds -ge 15000) { throw 'Crashed cold Scheduler instance did not settle.' }
        Start-Sleep -Milliseconds 100
    }
    if (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ $endpoint.port).Count) {
        throw 'Crashed cold application left its listener port open.'
    }
    Write-Output ($running | ConvertTo-Json -Depth 6 -Compress)
} finally {
    foreach ($process in @($bridge, $actor)) {
        if ($process -and -not $process.HasExited) {
            $process.Kill()
            if (-not $process.WaitForExit(15000)) { throw 'Cold crash fixture controller cleanup failed.' }
        }
    }
    if ($diagnostic) {
        $text = $diagnostic.GetAwaiter().GetResult()
        if ($text) { [Console]::Error.WriteLine($text) }
    }
    foreach ($process in @($listener, $runtime, $bridge, $actor)) {
        if ($process) { $process.Dispose() }
    }
}
