param(
    [Parameter(Mandatory)][string]$Control, [switch]$BeforeRunning,
    [ValidateSet('observed', 'started', 'requested', 'registered', 'enabled')][string]$StartupStep = 'observed'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../scripts/deployment/windows-cold-activation-context.ps1')
if ($StartupStep -cne 'observed' -and -not $BeforeRunning) {
    throw 'An earlier startup boundary requires pre-acknowledgement interruption.'
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
    $bridge = [Diagnostics.Process]::GetProcessById($running.controllerPid)
    $null = $bridge.Handle
    if ($StartupStep -cin @('requested', 'registered', 'enabled')) {
        $unlaunched = $StartupStep -ceq 'enabled'
        $expectedStatus = if ($unlaunched) { 'guarded-unlaunched' } else { 'guarded-preparation' }
        if ($running.status -cne $expectedStatus -or $running.step -cne $StartupStep -or
            $null -ne $running.runtime -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $running.controllerIdentity) {
            throw 'Preparation crash lost its original bridge or invented a runtime.'
        }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $folder = $scheduler.GetFolder('\')
        $task = $folder.GetTask($running.taskName)
        $expected = if ($StartupStep -ceq 'requested') {
            (Get-Content -LiteralPath (Join-Path $Control 'task-maintenance/task-stop-stopped.json') -Raw |
                ConvertFrom-Json).definition
        } else { $running.definition }
        if ([bool]$task.Enabled -ne $unlaunched -or $task.GetInstances(0).Count -ne 0 -or
            -not (Test-AgentsChatColdRecoveryDefinition $expected ([string]$task.Xml) -Unacknowledged -Enabled:$unlaunched) -or
            [string]$task.GetSecurityDescriptor(7) -cne $running.securityDescriptor) {
            throw 'Preparation crash changed its original disabled task policy or security.'
        }
        $running.definition = [string]$task.Xml
        $requestFile = Join-Path $Control 'recovery-lock/activation-start-requested.json'
        $requestHash = (Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash
        $enableFile = Join-Path ([IO.Path]::GetDirectoryName($running.configuration)) 'enable-requested.json'
        if ($unlaunched -and
            (Get-FileHash -LiteralPath $enableFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $running.enableSha256) {
            throw 'Unlaunched interruption changed its original enable intent.'
        }
        $bridge.Kill()
        if (-not $bridge.WaitForExit(15000)) { throw 'Original preparation bridge survived interruption.' }
        $actor.Kill()
        if (-not $actor.WaitForExit(15000)) { throw 'Original preparation actor survived interruption.' }
        if ($unlaunched) {
            $late = $folder.GetTask($running.taskName).Run($null)
            if (-not $late) { throw 'Late guarded demand-start did not return its real task instance.' }
            $deadline = [Diagnostics.Stopwatch]::StartNew()
            while ($folder.GetTask($running.taskName).GetInstances(0).Count -ne 0) {
                if ($deadline.ElapsedMilliseconds -ge 60000) { throw 'Late guarded host survived its absent original controller.' }
                Start-Sleep -Milliseconds 100
            }
            if ($folder.GetTask($running.taskName).LastTaskResult -ne 1 -or
                (Get-FileHash -LiteralPath $enableFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $running.enableSha256) {
                throw 'Late guarded demand-start did not fail with its original enable intent retained.'
            }
        }
        $entries = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($running.configuration)) -Force |
            Where-Object { $_.Name -imatch '^(launch|runtime)-.*\.json$' -or
                (-not $unlaunched -and $_.Name -ieq 'enable-requested.json') })
        $task = $folder.GetTask($running.taskName)
        if ($entries.Count -ne 0 -or [bool]$task.Enabled -ne $unlaunched -or $task.GetInstances(0).Count -ne 0 -or
            [string]$task.Xml -cne $running.definition -or
            [string]$task.GetSecurityDescriptor(7) -cne $running.securityDescriptor -or
            (Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash -cne $requestHash -or
            (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock/activation-running.json')) -or
            (Test-Path -LiteralPath (Join-Path $Control 'recovery-lock/activation-stopped.json'))) {
            throw 'Preparation interruption changed original evidence or attempted enabling.'
        }
        if ($unlaunched) {
            [Console]::Error.WriteLine('PASS: late guarded demand-start refuses its dead original controller before publishing launch or starting a workload')
        }
        Write-Output ($running | ConvertTo-Json -Depth 6 -Compress)
        return
    }
    $runtime = [Diagnostics.Process]::GetProcessById($running.runtime.pid)
    $null = $runtime.Handle
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $running.controllerIdentity -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.Id) -cne $running.runtime.identity) {
        throw 'Cold crash fixture lost its original bridge or runtime identity.'
    }
    if ($StartupStep -ceq 'started') {
        if ($running.status -cne 'guarded-launch') { throw 'Earlier crash fixture fabricated a running observation.' }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $task = $scheduler.GetFolder('\').GetTask($running.taskName)
        $instances = $task.GetInstances(0).Count
        $securityMatches = [string]$task.GetSecurityDescriptor(7) -ceq $running.securityDescriptor
        $policyMatches = Test-AgentsChatColdRecoveryDefinition $running.definition ([string]$task.Xml) -Unacknowledged -Enabled
        $xml = [xml][string]$task.Xml
        $namespaces = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $enabledNodes = $xml.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces).Count
        if (-not $task.Enabled -or $instances -ne 1 -or -not $securityMatches -or -not $policyMatches) {
            throw "Earlier guarded task differs: enabled=$($task.Enabled); instances=$instances; security=$securityMatches; policy=$policyMatches; enabledElements=$enabledNodes."
        }
        $running.definition = [string]$task.Xml
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
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    throw
} finally {
    foreach ($process in @($bridge, $actor)) {
        if ($process -and -not $process.HasExited) {
            $process.Kill()
            if (-not $process.WaitForExit(15000)) { throw 'Cold crash fixture controller cleanup failed.' }
        }
    }
    foreach ($process in @($runtime, $listener)) {
        if ($process -and -not $process.HasExited -and -not $process.WaitForExit(60000)) {
            throw 'Cold crash fixture guarded runtime or listener did not settle after controller cleanup.'
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
