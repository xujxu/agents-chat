param(
    [Parameter(Mandatory)][string]$Control, [switch]$BeforeRunning,
    [ValidateSet('observed', 'started')][string]$StartupStep = 'observed'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-cold-activation-context.ps1')
if ($StartupStep -ceq 'started' -and -not $BeforeRunning) {
    throw 'The started boundary requires pre-acknowledgement interruption.'
}
$actor = $bridge = $runtime = $listener = $diagnostic = $null
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('PATH', $env:PATH)
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
try {
    $mode = if ($BeforeRunning) { "$StartupStep-crash" } else { 'crash' }
    $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
        (Join-Path $PSScriptRoot 'deployment-windows-cold-activation.mjs'), $Control,
        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $mode), $Control, $environment)
    $diagnostic = $actor.StandardError.ReadToEndAsync()
    $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
    if (-not $frame.Wait(600000)) { throw 'Cold crash actor did not publish its admitted running runtime.' }
    $running = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
    if ($StartupStep -ceq 'started') {
        if ($running.status -cne 'guarded-launch') { throw 'Earlier crash fixture fabricated a running observation.' }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $task = $scheduler.GetFolder('\').GetTask($running.taskName)
        if (-not $task.Enabled -or $task.GetInstances(0).Count -ne 1 -or
            [string]$task.GetSecurityDescriptor(7) -cne $running.securityDescriptor -or
            -not (Test-AgentsChatColdRecoveryDefinition $running.definition ([string]$task.Xml) -Unacknowledged -Enabled)) {
            throw 'Earlier startup did not retain its exact enabled guarded task and instance.'
        }
        $running.definition = [string]$task.Xml
    }
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
    $receiptName = if ($BeforeRunning) { 'start-requested' } else { 'running' }
    $runningFile = Join-Path $Control "recovery-lock/activation-$receiptName.json"
    $runningHash = (Get-FileHash -LiteralPath $runningFile -Algorithm SHA256).Hash
    $launchFile = Join-Path ([IO.Path]::GetDirectoryName($running.configuration)) `
        "launch-$($running.runtime.identity.Replace(':', '-')).json"
    $launchHash = (Get-FileHash -LiteralPath $launchFile -Algorithm SHA256).Hash
    if ($BeforeRunning -and (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock/activation-running.json'))) {
        throw 'Pre-acknowledgement cold fixture already contains a running receipt.'
    }
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
        throw 'Cold crash fixture changed its original activation prefix.'
    }
    if ((Get-FileHash -LiteralPath $launchFile -Algorithm SHA256).Hash -cne $launchHash -or
        ($BeforeRunning -and (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock/activation-running.json')))) {
        throw 'Cold crash changed its original launch proof or manufactured a running receipt.'
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
