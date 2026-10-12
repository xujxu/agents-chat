param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$ChatId,
    [Parameter(Mandatory)][string]$TargetCommit,
    [ValidateSet('complete', 'cancelled', 'failed', 'crashed', 'copy-crashed', 'offline')][string]$RestoreScenario = 'complete'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helpers = Join-Path $repository 'scripts/deployment'
. (Join-Path $PSScriptRoot 'deployment-windows-restore-egress.ps1')
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs', 'WindowsControllerCapture.cs', 'WindowsRuntimeDomain.cs',
    'WindowsRuntimePipe.cs', 'WindowsRuntimeControl.cs' | ForEach-Object { Join-Path $helpers $_ })
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$git = (Get-Command git).Source
$npm = Join-Path (Split-Path $Node) 'node_modules/npm/bin/npm-cli.js'
$control = Join-Path (Split-Path -Parent $Project) ".$(Split-Path -Leaf $Project).deployment"
$directory = Join-Path $Root 'captured-controller'
$capture = $null
$actor = $null
$egress = $null
$coldOwner = $null
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
try {
    [Deployment.WindowsPrivateFile]::CreateDirectory($control).Dispose()
    $capture = [Deployment.WindowsControllerCapture]::Create($repository, $Project, $directory)
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $Root)
    $environment.Add('TMP', $Root)
    $recoveryEngine = ''
    $modes = if ($RestoreScenario -in @('complete', 'offline')) { @('update', 'verify-closed', 'current', 'restore', 'restore-closed') }
        elseif ($RestoreScenario -in @('crashed', 'copy-crashed')) { @('update', 'verify-closed', 'current', "restore-$RestoreScenario", 'restore-crash-verified') }
        else { @('update', 'verify-closed', 'current', "restore-$RestoreScenario") }
    if ($RestoreScenario -eq 'copy-crashed') { $modes += 'restore-cold-files' }
    foreach ($mode in $modes) {
        if ($RestoreScenario -eq 'offline' -and $mode -eq 'restore') {
            $egress = Enable-WindowsRestoreEgressBlock -Node $Node -Pwsh $pwsh -Git $git
        }
        $elapsed = [Diagnostics.Stopwatch]::StartNew()
        $capture.Check()
        $before = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        Assert ($before.Count -eq 1) 'Live application must have one original task instance'
        $originalPid = $before.Item(1).EnginePID
        $originalInstance = $before.Item(1).InstanceGuid
        if ($mode -eq 'restore-cold-files') {
            $coldOwner = [Diagnostics.Process]::GetProcessById([int]$originalPid)
            $null = $coldOwner.Handle
            $coldIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($coldOwner.Id)
            $coldSession = $coldOwner.SessionId
            $coldTask = $scheduler.GetFolder('\').GetTask($TaskName)
            $coldDefinition = [string]$coldTask.Xml
            $coldSecurity = [string]$coldTask.GetSecurityDescriptor(7)
        }
        $actor = [Deployment.WindowsControllerProcess]::Start($Node,
            @((Join-Path $PSScriptRoot 'deployment-windows-live-application.mjs'),
                $mode, $directory, $Project, $control, $TaskName, $pwsh, $git, $npm, $TargetCommit, $recoveryEngine, $ChatId), $directory, $environment)
        $output = $actor.StandardOutput.ReadToEndAsync()
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $actorTimeout = if ($mode -in @('restore', 'restore-cancelled', 'restore-failed', 'restore-crashed', 'restore-copy-crashed', 'restore-cold-files')) { 2700000 } elseif ($mode -eq 'update') { 1800000 } else { 300000 }
        $exited = $actor.WaitForExit($actorTimeout)
        $actor.Kill()
        Assert ($actor.WaitForExit(15000)) 'Live application controller did not settle after Job termination'
        $code = $actor.ExitCode
        Assert ($output.Wait(15000) -and $diagnostic.Wait(15000)) 'Live controller streams did not settle'
        [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
        $text = $output.GetAwaiter().GetResult()
        if (-not $exited) {
            try {
                $stateFile = Join-Path $control 'state.json'
                Assert ((Get-Item -LiteralPath $stateFile).Length -le 65536) 'Fixture state exceeds diagnostic bound'
                $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
                Assert ($state.phase -is [string] -and $state.phase -cmatch '^[a-z-]{1,64}$') 'Invalid fixture phase'
                [Console]::Error.WriteLine("Timed out $mode actor; last recorded phase: $($state.phase)")
            } catch {
                [Console]::Error.WriteLine("Timed out $mode actor; state diagnostic unavailable: $($_.Exception.GetType().FullName)")
            }
        }
        Assert $exited "Live application controller $mode exceeded its bound; output: $text"
        if ($mode -in @('restore-crashed', 'restore-copy-crashed')) {
            Assert ($code -ne 0 -and [string]::IsNullOrWhiteSpace($text)) 'Crashed restore reported successful completion'
            $actor.Dispose()
            $actor = $null
            $capture.Check()
            $crashed = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
            Assert ($crashed.Count -eq 1 -and $crashed.Item(1).EnginePID -eq $originalPid -and
                $crashed.Item(1).InstanceGuid -ceq $originalInstance) 'Controller death replaced the original runtime'
            Write-Output "Original restore actor terminated without a result; verifying its retained crash evidence; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        Assert ($code -eq 0) "Live controller $mode failed: $text"
        $result = $text | ConvertFrom-Json
        $expected = switch ($mode) {
            update { 'accepted' } verify-closed { 'completed' } current { 'already-current' }
            restore { 'restored' } restore-closed { 'completed' }
            restore-cancelled { 'cancelled' }
            restore-failed { 'failed' }
            restore-crash-verified { 'crash-verified' }
            restore-cold-files { 'guarded-stopped' }
        }
        Assert ($result.status -ceq $expected) "Unexpected live controller $mode status"
        $actor.Dispose()
        $actor = $null
        $capture.Check()
        $after = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        if ($mode -eq 'restore-cold-files') {
            Assert ($result.retired -eq $true -and $result.runtime.pid -eq $originalPid -and
                $result.runtime.identity -ceq $coldIdentity) 'Cold restoration did not bind original runtime retirement'
            Assert ($coldOwner.WaitForExit(15000) -and $coldOwner.ExitCode -eq 0) 'Cold original runtime did not retire cleanly'
            Assert ($after.Count -eq 0) 'Cold retirement retained a Scheduler instance'
            $coldTask = $scheduler.GetFolder('\').GetTask($TaskName)
            Assert ($result.activation.status -ceq 'guarded-running' -and
                $result.activation.runtime.generation -cne $result.runtime.generation -and
                $result.readiness.status -ceq 'ready' -and $result.readiness.port -eq 3010 -and
                $result.readiness.generation -ceq $result.activation.runtime.generation) 'Cold application readiness lacks its new owned generation'
            Assert (-not $coldTask.Enabled -and [string]$coldTask.Xml -ceq $result.activation.definition -and
                [string]$coldTask.Xml -cne $coldDefinition -and $coldTask.Definition.Triggers.Count -eq 0 -and
                [string]$coldTask.GetSecurityDescriptor(7) -ceq $coldSecurity -and
                $result.activation.securityDescriptor -ceq $coldSecurity) 'Cold startup changed security or lost its exact inhibited guarded policy'
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$result.runtime.generation, $coldSession)
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$result.activation.runtime.generation, $result.activation.runtime.sessionId)
            Assert (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3010).Count -eq 0) `
                'Cold retirement retained the application listener'
            $coldOwner.Dispose()
            $coldOwner = $null
            Write-Output "PASS: real Windows cold restoration starts an owned ready application with restored API data and closes its guarded Job without terminal success; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        Assert ($after.Count -eq 1) 'Live deployment lost the application task'
        if ($mode -in @('restore-cancelled', 'restore-failed', 'restore-crash-verified')) {
            Assert ($after.Item(1).EnginePID -eq $originalPid -and $after.Item(1).InstanceGuid -ceq $originalInstance -and
                $result.runtime.pid -eq $originalPid) 'Interrupted restore replaced the original runtime'
            Assert (-not $scheduler.GetFolder('\').GetTask($TaskName).Enabled) 'Interrupted restore enabled restart'
            $observed = [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$result.runtime.generation, $result.runtime.pid,
                $result.runtime.identity, 'observe', 15000) | ConvertFrom-Json
            Assert ($observed.quiescent -and @($observed.members).Count -eq 0) 'Interrupted restore retained writers'
            Assert (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3010).Count -eq 0) `
                'Interrupted restore retained the application listener'
            Write-Output "PASS: real Windows $mode retains original inhibited runtime, backup and lock; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        if ($mode -in @('update', 'restore')) {
            Assert ($result.recoveryEngine -cmatch '^[a-f0-9]{64}$') 'Live deployment returned no exact saved recovery binding'
            $recoveryEngine = $result.recoveryEngine
            Assert ($after.Item(1).EnginePID -ne $originalPid -and $after.Item(1).InstanceGuid -cne $originalInstance) `
                'Live deployment did not activate a new original runtime'
        } else {
            Assert ($after.Item(1).EnginePID -eq $originalPid -and $after.Item(1).InstanceGuid -ceq $originalInstance) `
                'Closeout or already-current restarted the accepted application'
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId
            Assert ($LASTEXITCODE -eq 0) "Authenticated data was lost during $mode"
        }
        if ($mode -eq 'current') {
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') mutate $ChatId
            Assert ($LASTEXITCODE -eq 0) 'Cannot create acknowledged post-backup data change'
        }
        if ($mode -eq 'restore') {
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId
            Assert ($LASTEXITCODE -eq 0) 'Restore did not recover authenticated pre-backup data'
        }
        Write-Output "PASS: real Windows live deployment $mode with captured controller and preserved task/data; elapsedMs=$($elapsed.ElapsedMilliseconds)"
    }
    if ($egress) {
        Assert-WindowsRestoreEgressBlocked $egress
        Write-Output 'PASS: actual saved restoration and independent closeout completed with restore-executable external egress denied'
    }
} finally {
    try {
        if ($egress) { Disable-WindowsRestoreEgressBlock $egress }
    } finally {
        if ($coldOwner) { $coldOwner.Dispose() }
        if ($actor) { $actor.Dispose() }
        if ($capture) { $capture.Dispose() }
        $owners = @($scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0) | ForEach-Object {
            if ($_.EnginePID -gt 0) { [Diagnostics.Process]::GetProcessById([int]$_.EnginePID) }
        })
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        Stop-ScheduledTask -TaskName $TaskName
        foreach ($owner in $owners) {
            try { Assert ($owner.WaitForExit(15000)) 'Live fixture runtime did not settle' }
            finally { $owner.Dispose() }
        }
        Assert (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3010).Count -eq 0) `
            'Live fixture listener survived cleanup'
    }
}
