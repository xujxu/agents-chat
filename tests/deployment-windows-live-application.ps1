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
. (Join-Path $PSScriptRoot 'deployment-windows-process-lifetime-helper.ps1')
. (Join-Path $helpers 'windows-cold-activation-context.ps1')
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
$coldStateStage = $null
$coldTransaction = $null
$coldReceiptStage = $null
$coldRetirementManifest = $null
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
    $preparedCrashModes = @('restore-cold-requested-crashed', 'restore-cold-registered-crashed')
    $preparedCloseoutModes = @('restore-cold-requested-closeout', 'restore-cold-registered-closeout')
    $startupCrashModes = @('restore-cold-startup-crashed', 'restore-cold-launch-crashed', 'restore-cold-enabled-crashed') + $preparedCrashModes
    $startupCloseoutModes = @('restore-cold-startup-closeout', 'restore-cold-launch-closeout', 'restore-cold-enabled-closeout') + $preparedCloseoutModes
    $coldCloseoutModes = @('restore-cold-start-closeout') + $startupCloseoutModes
    $modes = if ($RestoreScenario -in @('complete', 'offline')) { @('update', 'verify-closed', 'current', 'restore', 'restore-closed') }
        elseif ($RestoreScenario -in @('crashed', 'copy-crashed')) { @('update', 'verify-closed', 'current', "restore-$RestoreScenario", 'restore-crash-verified') }
        else { @('update', 'verify-closed', 'current', "restore-$RestoreScenario") }
    if ($RestoreScenario -eq 'copy-crashed' -and $env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'start') {
        $modes += 'restore-cold-start-closeout'
    } elseif ($RestoreScenario -eq 'copy-crashed' -and $env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'startup') {
        $modes += @('restore-cold-startup-crashed', 'restore-cold-startup-closeout')
    } elseif ($RestoreScenario -eq 'copy-crashed' -and $env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'launch') {
        $modes += @('restore-cold-launch-crashed', 'restore-cold-launch-closeout')
    } elseif ($RestoreScenario -eq 'copy-crashed' -and $env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'enabled') {
        $modes += @('restore-cold-enabled-crashed', 'restore-cold-enabled-closeout')
    } elseif ($RestoreScenario -eq 'copy-crashed' -and $env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -in @('requested', 'registered')) {
        $prefix = "restore-cold-$($env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY)"
        $modes += @("$prefix-crashed", "$prefix-closeout")
    } elseif ($RestoreScenario -eq 'copy-crashed') {
        $modes += 'restore-cold-files'
        if ($env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'completion') {
            $modes += 'restore-cold-completion-closeout'
        } else {
            $modes += @('restore-cold-policy-crashed', 'restore-cold-enable-crashed',
                'restore-cold-completed', 'restore-cold-observed', 'restore-cold-state-staged')
            if ($env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'state') {
                $modes += 'restore-cold-state-closeout'
            } else {
                $modes += @('restore-cold-state-published', 'restore-cold-state-completed', 'restore-cold-receipt-staged')
                if ($env:DEPLOYMENT_TEST_WINDOWS_COLD_ENTRY -eq 'receipt') {
                    $modes += 'restore-cold-receipt-closeout'
                } else {
                    $modes += @('restore-cold-receipt-published', 'restore-cold-receipt-completed',
                        'restore-cold-retirement-prepared', 'restore-cold-retirement-early',
                        'restore-cold-retirement-unlock', 'restore-cold-retirement-completed')
                }
            }
        }
    }
    foreach ($mode in $modes) {
        if ($RestoreScenario -eq 'offline' -and $mode -eq 'restore') {
            $egress = Enable-WindowsRestoreEgressBlock -Node $Node -Pwsh $pwsh -Git $git
        }
        $elapsed = [Diagnostics.Stopwatch]::StartNew()
        $capture.Check()
        $before = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        if ($mode -in $startupCloseoutModes) {
            Assert ($before.Count -eq 0) 'Interrupted guarded startup must have no remaining task instance'
            $originalPid = $guardedStartup.runtime.pid
            $originalInstance = if ($mode -in (@('restore-cold-enabled-closeout') + $preparedCloseoutModes)) {
                $guardedStartup.runtime.instanceGuid
            } else { $guardedStartup.activation.runtime.instanceGuid }
        } else {
            Assert ($before.Count -eq 1) 'Live application must have one original task instance'
            $originalPid = $before.Item(1).EnginePID
            $originalInstance = $before.Item(1).InstanceGuid
        }
        if ($mode -in (@('restore-cold-files', 'restore-cold-start-closeout') + $startupCrashModes)) {
            $coldOwner = [Diagnostics.Process]::GetProcessById([int]$originalPid)
            $null = $coldOwner.Handle
            $coldIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($coldOwner.Id)
            $coldSession = $coldOwner.SessionId
            $coldTask = $scheduler.GetFolder('\').GetTask($TaskName)
            $coldDefinition = [string]$coldTask.Xml
            $coldSecurity = [string]$coldTask.GetSecurityDescriptor(7)
        }
        if ($mode -eq 'restore-cold-state-staged') {
            $transactionPath = Join-Path $control 'task-maintenance/transaction.json'
            $transactionHash = (Get-FileHash -LiteralPath $transactionPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $file = [Deployment.WindowsPrivateFile]::Open($transactionPath, $transactionHash)
            try { $coldTransaction = @{ identity=$file.CaptureIdentity(); sha256=$file.Sha256 } }
            finally { $file.Dispose() }
        }
        $actor = [Deployment.WindowsControllerProcess]::Start($Node,
            @((Join-Path $PSScriptRoot 'deployment-windows-live-application.mjs'),
                $mode, $directory, $Project, $control, $TaskName, $pwsh, $git, $npm, $TargetCommit, $recoveryEngine, $ChatId), $directory, $environment)
        $output = $actor.StandardOutput.ReadToEndAsync()
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $actorTimeout = if ($mode -in $coldCloseoutModes) { 3600000 } elseif ($mode -in (@('restore', 'restore-cancelled', 'restore-failed', 'restore-crashed', 'restore-copy-crashed', 'restore-cold-files') + $startupCrashModes)) { 2700000 } elseif ($mode -eq 'update') { 1800000 } elseif ($mode -like 'restore-cold-receipt-*' -or $mode -like 'restore-cold-retirement-*' -or $mode -like 'restore-cold-*-closeout') { 900000 } else { 300000 }
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
        $completionInterrupted = $mode -in (@('restore-cold-files', 'restore-cold-policy-crashed', 'restore-cold-enable-crashed') + $startupCrashModes)
        $terminalInterrupted = $mode -in @('restore-cold-state-staged', 'restore-cold-state-published',
            'restore-cold-receipt-staged', 'restore-cold-receipt-published',
            'restore-cold-retirement-prepared', 'restore-cold-retirement-early', 'restore-cold-retirement-unlock')
        $expectedCode = if ($completionInterrupted -or $terminalInterrupted) { 91 } else { 0 }
        Assert ($code -eq $expectedCode) "Live controller $mode returned an unexpected exit code ${code}: $text"
        $result = $text | ConvertFrom-Json
        $expected = switch ($mode) {
            update { 'accepted' } verify-closed { 'completed' } current { 'already-current' }
            restore { 'restored' } restore-closed { 'completed' }
            restore-cancelled { 'cancelled' }
            restore-failed { 'failed' }
            restore-crash-verified { 'crash-verified' }
            restore-cold-files { 'cold-completion-interrupted' }
            restore-cold-policy-crashed { 'cold-completion-interrupted' }
            restore-cold-enable-crashed { 'cold-completion-interrupted' }
            restore-cold-completed { 'cold-runtime-recovered' }
            restore-cold-observed { 'cold-runtime-observed' }
            restore-cold-state-staged { 'cold-terminal-state-interrupted' }
            restore-cold-state-published { 'cold-terminal-state-interrupted' }
            restore-cold-state-completed { 'cold-terminal-state-recovered' }
            restore-cold-receipt-staged { 'cold-restored-receipt-interrupted' }
            restore-cold-receipt-published { 'cold-restored-receipt-interrupted' }
            restore-cold-receipt-completed { 'cold-restored-receipt-recovered' }
            restore-cold-receipt-closeout { 'cold-receipt-closeout-completed' }
            restore-cold-state-closeout { 'cold-state-closeout-completed' }
            restore-cold-completion-closeout { 'cold-completion-closeout-completed' }
            restore-cold-start-closeout { 'cold-start-closeout-completed' }
            restore-cold-startup-crashed { 'cold-startup-interrupted' }
            restore-cold-startup-closeout { 'cold-startup-closeout-completed' }
            restore-cold-launch-crashed { 'cold-launch-interrupted' }
            restore-cold-launch-closeout { 'cold-launch-closeout-completed' }
            restore-cold-enabled-crashed { 'cold-enabled-interrupted' }
            restore-cold-enabled-closeout { 'cold-enabled-closeout-completed' }
            restore-cold-requested-crashed { 'cold-requested-interrupted' }
            restore-cold-requested-closeout { 'cold-requested-closeout-completed' }
            restore-cold-registered-crashed { 'cold-registered-interrupted' }
            restore-cold-registered-closeout { 'cold-registered-closeout-completed' }
            restore-cold-retirement-prepared { 'cold-retirement-interrupted' }
            restore-cold-retirement-early { 'cold-retirement-interrupted' }
            restore-cold-retirement-unlock { 'cold-retirement-interrupted' }
            restore-cold-retirement-completed { 'cold-retirement-completed' }
        }
        Assert ($result.status -ceq $expected) "Unexpected live controller $mode status"
        $actor.Dispose()
        $actor = $null
        $capture.Check()
        $after = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        if ($mode -in $coldCloseoutModes) {
            Assert ($result.retiredRuntime.pid -eq $originalPid -and $result.retiredRuntime.identity -ceq $coldIdentity) `
                'Public cold restore changed its original retirement identity'
            if ($mode -eq 'restore-cold-start-closeout') {
                Assert ($coldOwner.WaitForExit(15000) -and $coldOwner.ExitCode -eq 0) 'Public cold restore did not retire its original stopped runtime'
                $coldOwner.Dispose()
                $coldOwner = $null
            } elseif ($mode -in $preparedCloseoutModes) {
                Assert ($result.preparationSha256 -ceq $guardedStartup.activation.preparationSha256 -and
                    $null -eq $result.PSObject.Properties['interruptedRuntime']) `
                    'Public preparation recovery changed its original request or invented an interrupted runtime'
            } else {
                Assert ($result.interruptedRuntime.generation -ceq $guardedStartup.activation.runtime.generation -and
                    $result.interruptedRuntime.pid -eq $guardedStartup.activation.runtime.pid -and
                    $result.interruptedRuntime.identity -ceq $guardedStartup.activation.runtime.identity -and
                    -not (Test-WindowsFixtureProcessIdentity $result.interruptedRuntime.pid $result.interruptedRuntime.identity)) `
                    'Public cold startup changed or revived its interrupted guarded generation'
                [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                    [guid]$result.interruptedRuntime.generation, $result.interruptedRuntime.sessionId)
            }
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$result.retiredRuntime.generation, $coldSession)
            $runtime = $result.runtime
            Assert ($after.Count -eq 1 -and $after.Item(1).EnginePID -eq $runtime.pid -and
                ([guid]$after.Item(1).InstanceGuid).ToString('D') -ceq $runtime.instanceGuid -and
                $runtime.instanceGuid -cne ([guid]$originalInstance).ToString('D') -and
                [Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -ceq $runtime.identity -and
                $result.lease -ceq 'released' -and [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') `
                'Public cold restore did not retain its distinct released Scheduler runtime'
            $coldTask = $scheduler.GetFolder('\').GetTask($TaskName)
            Assert ($coldTask.Enabled -and [string]$coldTask.Xml -cne $coldDefinition -and
                [string]$coldTask.GetSecurityDescriptor(7) -ceq $coldSecurity -and $result.boundary -ceq 'complete') `
                'Public cold restore changed task security or did not complete permanent policy'
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId
            Assert ($LASTEXITCODE -eq 0) 'Public cold restore lost authenticated pre-backup data'
            Write-Output "PASS: real Windows live deployment $mode with original retired Job, new released task and preserved backup/data; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        if ($mode -in $preparedCrashModes) {
            $step = if ($mode -eq 'restore-cold-requested-crashed') { 'requested' } else { 'registered' }
            Assert ($result.retired -eq $true -and $result.runtime.pid -eq $originalPid -and
                $result.runtime.identity -ceq $coldIdentity -and $coldOwner.WaitForExit(15000) -and
                $coldOwner.ExitCode -eq 0) 'Preparation did not retire its genuine original stopped runtime'
            Assert ($result.activation.status -ceq 'guarded-preparation' -and
                $result.activation.step -ceq $step -and $null -eq $result.activation.runtime -and
                $null -eq $result.readiness -and $result.activation.taskName -ceq $TaskName) `
                'Interrupted preparation fabricated runtime readiness or changed its boundary'
            $settlement = [Diagnostics.Stopwatch]::StartNew()
            while ((Test-WindowsFixtureProcessIdentity $result.activation.controllerPid $result.activation.controllerIdentity) -or
                $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0).Count -ne 0) {
                Assert ($settlement.ElapsedMilliseconds -lt 60000) 'Preparation bridge or Scheduler instance did not settle'
                Start-Sleep -Milliseconds 100
            }
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$result.runtime.generation, $coldSession)
            Assert (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ 3010).Count -eq 0) `
                'Never-enabled preparation left an application listener'
            $task = $scheduler.GetFolder('\').GetTask($TaskName)
            $expectedDefinition = if ($step -ceq 'requested') { $coldDefinition } else { $result.activation.plannedDefinition }
            Assert (-not $task.Enabled -and
                [string]$task.GetSecurityDescriptor(7) -ceq $coldSecurity -and
                (Test-AgentsChatColdRecoveryDefinition $expectedDefinition ([string]$task.Xml) -Unacknowledged)) `
                'Interrupted preparation changed its exact original or guarded disabled task'
            $requestFile = Join-Path $control 'recovery-lock/activation-start-requested.json'
            $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
            Assert ($request.version -eq 2 -and $null -eq $request.runtime -and
                $request.controllerPid -eq $result.activation.controllerPid -and
                $request.controllerIdentity -ceq $result.activation.controllerIdentity -and
                $request.configuration -ceq $result.activation.configuration -and
                (Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $result.activation.preparationSha256) `
                'Preparation interruption lost its versioned original request'
            $entries = @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($request.configuration)) -Force |
                Where-Object { $_.Name -imatch '^(enable-requested|(launch|runtime)-.*)\.json$' })
            Assert ($entries.Count -eq 0 -and
                -not (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/activation-running.json')) -and
                -not (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/activation-stopped.json')) -and
                -not (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/completion-release-requested.json'))) `
                'Never-enabled preparation contains later startup evidence'
            $coldOwner.Dispose()
            $coldOwner = $null
            $guardedStartup = $result
            Write-Output "PASS: real Windows $step preparation controller death preserves disabled policy without enable, launch or runtime invention; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        if ($mode -in $startupCrashModes) {
            $beforeInhibition = $mode -eq 'restore-cold-enabled-crashed'
            $unacknowledged = $mode -in @('restore-cold-launch-crashed', 'restore-cold-enabled-crashed')
            Assert ($result.retired -eq $true -and $result.runtime.pid -eq $originalPid -and
                $result.runtime.identity -ceq $coldIdentity -and $coldOwner.WaitForExit(15000) -and
                $coldOwner.ExitCode -eq 0) 'Guarded startup did not retire its original stopped runtime'
            $expectedStatus = if ($beforeInhibition) { 'guarded-launch' } else { 'guarded-running' }
            Assert ($result.activation.status -ceq $expectedStatus -and
                $result.activation.runtime.generation -cne $result.runtime.generation) 'Interrupted guarded application reused its original runtime'
            Assert ($result.readiness.status -ceq 'ready' -and $result.readiness.port -eq 3010 -and
                $result.readiness.generation -ceq $result.activation.runtime.generation) `
                'Interrupted guarded application lacks owned readiness'
            $runtime = $result.activation.runtime
            $settlement = [Diagnostics.Stopwatch]::StartNew()
            while ((Test-WindowsFixtureProcessIdentity $runtime.pid $runtime.identity) -or
                $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0).Count -ne 0) {
                Assert ($settlement.ElapsedMilliseconds -lt 60000) 'Interrupted guarded runtime or Scheduler instance did not settle'
                Start-Sleep -Milliseconds 100
            }
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$result.runtime.generation, $coldSession)
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$runtime.generation, $runtime.sessionId)
            Assert (@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -EQ 3010).Count -eq 0) `
                'Interrupted guarded application left an active listener'
            $task = $scheduler.GetFolder('\').GetTask($TaskName)
            $definitionMatches = if ($beforeInhibition) {
                Test-AgentsChatColdRecoveryDefinition $result.activation.plannedDefinition ([string]$task.Xml) `
                    -Unacknowledged -Enabled
            } else { [string]$task.Xml -ceq $result.activation.definition }
            Assert ([bool]$task.Enabled -eq $beforeInhibition -and
                [string]$task.GetSecurityDescriptor(7) -ceq $coldSecurity -and $definitionMatches -and
                (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/activation-start-requested.json')) -and
                (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/activation-running.json')) -eq (-not $unacknowledged) -and
                -not (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/completion-release-requested.json'))) `
                'Guarded interruption changed its exact startup policy, original security or unreleased boundary'
            $coldOwner.Dispose()
            $coldOwner = $null
            $guardedStartup = $result
            if ($beforeInhibition) {
                Write-Output "PASS: real Windows pre-inhibition launch controller death settles both original Jobs and preserves enabled guarded policy; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            } elseif ($unacknowledged) {
                Write-Output "PASS: real Windows unacknowledged launch controller death settles both original Jobs without a running receipt; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            } else {
                Write-Output "PASS: real Windows guarded startup controller death settles both original Jobs and retains its unreleased history; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            }
            continue
        }
        if ($mode -eq 'restore-cold-files') {
            Assert ($result.retired -eq $true -and $result.runtime.pid -eq $originalPid -and
                $result.runtime.identity -ceq $coldIdentity) 'Cold restoration did not bind original runtime retirement'
            Assert ($coldOwner.WaitForExit(15000) -and $coldOwner.ExitCode -eq 0) 'Cold original runtime did not retire cleanly'
            Assert ($after.Count -eq 1 -and $after.Item(1).EnginePID -eq $result.activation.runtime.pid -and
                ([guid]$after.Item(1).InstanceGuid).ToString('D') -ceq $result.activation.runtime.instanceGuid) `
                'Cold completion lost its original new Scheduler instance'
            $coldTask = $scheduler.GetFolder('\').GetTask($TaskName)
            Assert ($result.activation.status -ceq 'guarded-running' -and
                $result.activation.runtime.generation -cne $result.runtime.generation -and
                $result.readiness.status -ceq 'ready' -and $result.readiness.port -eq 3010 -and
                $result.readiness.generation -ceq $result.activation.runtime.generation) 'Cold application readiness lacks its new owned generation'
            Assert (-not $coldTask.Enabled -and $result.enabled -eq $false -and
                [string]$coldTask.Xml -ceq $result.definition -and
                [string]$coldTask.Xml -cne $coldDefinition -and
                [string]$coldTask.GetSecurityDescriptor(7) -ceq $coldSecurity -and
                $result.activation.securityDescriptor -ceq $coldSecurity -and
                $result.progress.step -ceq 'lease-released' -and $result.progress.lease -ceq 'released') `
                'Interrupted cold completion changed security or lost its staged released boundary'
            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'recovery-lock/completion-released.json'))) `
                'Cold release interruption already has its durable acknowledgement'
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$result.runtime.generation, $coldSession)
            $runtime = $result.activation.runtime
            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -ceq $runtime.identity -and
                [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') `
                'Cold application did not survive its original controller with its released lease'
            $coldOwner.Dispose()
            $coldOwner = $null
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId
            Assert ($LASTEXITCODE -eq 0) 'Authenticated restored data was lost after cold release interruption'
            Write-Output "PASS: real Windows cold application survives released-lease controller death before its durable acknowledgement; elapsedMs=$($elapsed.ElapsedMilliseconds)"
            continue
        }
        Assert ($after.Count -eq 1) 'Live deployment lost the application task'
        if ($mode -in @('restore-cold-policy-crashed', 'restore-cold-enable-crashed', 'restore-cold-completed')) {
            $runtime = $result.runtime
            Assert ($runtime.pid -eq $originalPid -and $runtime.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($originalPid) -and
                $runtime.instanceGuid -ceq ([guid]$originalInstance).ToString('D') -and $result.lease -ceq 'released' -and
                [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') `
                'Actual completion recovery lost or restarted its original released application'
            $expectedStep = switch ($mode) {
                'restore-cold-policy-crashed' { 'permanent-policy-applied' }
                'restore-cold-enable-crashed' { 'enable-applied' }
                'restore-cold-completed' { 'complete' }
            }
            Assert ($result.step -ceq $expectedStep) 'Actual completion recovery skipped its requested boundary'
            if ($completionInterrupted) {
                $missing = if ($mode -ceq 'restore-cold-policy-crashed') { 'policy-restored' } else { 'complete' }
                Assert (-not (Test-Path -LiteralPath (Join-Path $control "recovery-lock/completion-$missing.json"))) `
                    'Actual physical completion interruption already has its durable acknowledgement'
            }
        }
        if ($mode -eq 'restore-cold-observed') {
            Assert ($result.mutationAuthority -eq $false -and $result.lease -ceq 'released' -and
                $result.port -eq 3010 -and $result.runtime.pid -eq $originalPid -and
                $result.runtime.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($originalPid) -and
                $result.runtime.instanceGuid -ceq ([guid]$originalInstance).ToString('D')) `
                'Independent cold observation did not retain the original released application'
        }
        if ($mode -in @('restore-cold-state-staged', 'restore-cold-state-published', 'restore-cold-state-completed',
            'restore-cold-receipt-staged', 'restore-cold-receipt-published', 'restore-cold-receipt-completed')) {
            $file = [Deployment.WindowsPrivateFile]::Open(
                (Join-Path $control 'task-maintenance/transaction.json'), $coldTransaction.sha256)
            try {
                $identity = $file.CaptureIdentity()
                Assert ($identity.Dev -ceq $coldTransaction.identity.Dev -and $identity.Ino -ceq $coldTransaction.identity.Ino) `
                    'Actual terminal recovery changed the original exclusive transaction inode'
            } finally { $file.Dispose() }
            $runtime = $result.runtime
            Assert ($runtime.pid -eq $originalPid -and
                $runtime.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($originalPid) -and
                $runtime.instanceGuid -ceq ([guid]$originalInstance).ToString('D') -and $result.lease -ceq 'released' -and
                [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') `
                'Actual terminal publication lost or restarted its original released runtime'
            $expectedStep = switch ($mode) {
                'restore-cold-state-staged' { 'state-staged' }
                'restore-cold-state-published' { 'state-published' }
                'restore-cold-state-completed' { 'complete' }
                'restore-cold-receipt-staged' { 'receipt-staged' }
                'restore-cold-receipt-published' { 'receipt-published' }
                'restore-cold-receipt-completed' { 'complete' }
            }
            $terminal = Get-Content -LiteralPath (Join-Path $control 'cold-restore-terminal.json') -Raw | ConvertFrom-Json
            if ($mode -like 'restore-cold-receipt-*') {
                $receiptPath = if ($mode -ceq 'restore-cold-receipt-staged') {
                    Join-Path $control '.deployment.json.staging'
                } else { Join-Path $control 'deployment.json' }
                $receiptHash = if ($mode -ceq 'restore-cold-receipt-staged') {
                    (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
                } else { $coldReceiptStage.sha256 }
                $file = [Deployment.WindowsPrivateFile]::Open($receiptPath, $receiptHash)
                try {
                    $identity = $file.CaptureIdentity()
                    $receipt = $file.ReadText() | ConvertFrom-Json
                    Assert ($receipt.operationId -ceq $terminal.operationId -and
                        $receipt.acceptedAt -ceq ($terminal.nextState | ConvertFrom-Json).updatedAt) `
                        'Actual cold receipt changed its original terminal operation or timestamp'
                    if ($mode -ceq 'restore-cold-receipt-staged') {
                        $coldReceiptStage = @{ identity=$identity; sha256=$receiptHash }
                    } else {
                        Assert ($identity.Dev -ceq $coldReceiptStage.identity.Dev -and $identity.Ino -ceq $coldReceiptStage.identity.Ino) `
                            'Actual cold receipt did not preserve its original staged inode'
                        Assert (-not (Test-Path -LiteralPath (Join-Path $control '.deployment.json.staging'))) `
                            'Actual cold receipt publication retained its stage'
                    }
                } finally { $file.Dispose() }
            }
            Assert ($result.step -ceq $expectedStep) 'Actual terminal publication skipped its requested boundary'
            $nextHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes($terminal.nextState))).ToLowerInvariant()
            $currentState = Get-Content -LiteralPath (Join-Path $control 'state.json') -Raw
            if ($mode -ceq 'restore-cold-state-staged') {
                Assert ($currentState -ceq $terminal.oldState) 'Staging already replaced original state'
                $file = [Deployment.WindowsPrivateFile]::Open((Join-Path $control 'state.json.lock'), $nextHash)
                try {
                    Assert ($file.ReadText() -ceq $terminal.nextState) 'Actual staged state differs from its original handoff'
                    $coldStateStage = $file.CaptureIdentity()
                } finally { $file.Dispose() }
            } else {
                Assert ($currentState -ceq $terminal.nextState) 'Actual terminal state differs from its original handoff'
                Assert (-not (Test-Path -LiteralPath (Join-Path $control 'state.json.lock'))) 'Actual publication retained its stage'
                $file = [Deployment.WindowsPrivateFile]::Open((Join-Path $control 'state.json'), $nextHash)
                try {
                    $identity = $file.CaptureIdentity()
                    Assert ($coldStateStage -and $identity.Dev -ceq $coldStateStage.Dev -and $identity.Ino -ceq $coldStateStage.Ino) `
                        'Actual terminal publication did not preserve its original staged inode'
                } finally { $file.Dispose() }
            }
        }
        if ($mode -like 'restore-cold-retirement-*' -or $mode -cin @(
            'restore-cold-receipt-closeout', 'restore-cold-state-closeout', 'restore-cold-completion-closeout')) {
            $runtime = $result.runtime
            Assert ($runtime.pid -eq $originalPid -and
                $runtime.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($originalPid) -and
                $runtime.instanceGuid -ceq ([guid]$originalInstance).ToString('D') -and $result.lease -ceq 'released' -and
                [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') `
                'Actual cold retirement changed its original runtime or Scheduler instance'
            $acceptedEvidence = @()
            if ($mode -cne 'restore-cold-completion-closeout') {
                $acceptedEvidence += @{ name='state.json'; sha256=$nextHash; identity=$coldStateStage }
            }
            if ($mode -cnotin @('restore-cold-state-closeout', 'restore-cold-completion-closeout')) {
                $acceptedEvidence += @{ name='deployment.json'; sha256=$coldReceiptStage.sha256; identity=$coldReceiptStage.identity }
            }
            foreach ($evidence in $acceptedEvidence) {
                $file = [Deployment.WindowsPrivateFile]::Open((Join-Path $control $evidence.name), $evidence.sha256)
                try {
                    $identity = $file.CaptureIdentity()
                    Assert ($identity.Dev -ceq $evidence.identity.Dev -and $identity.Ino -ceq $evidence.identity.Ino) `
                        'Actual cold retirement changed accepted state or receipt inode'
                } finally { $file.Dispose() }
            }
            $marker = Join-Path $control 'worker-retirement.json'
            if ($mode -in @('restore-cold-retirement-completed', 'restore-cold-receipt-closeout',
                'restore-cold-state-closeout', 'restore-cold-completion-closeout')) {
                Assert ($result.boundary -ceq 'complete' -and -not (Test-Path -LiteralPath $marker) -and
                    -not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Actual cold retirement did not finish original unlock'
            } else {
                $expectedBoundary = $mode.Substring('restore-cold-retirement-'.Length)
                Assert ($result.boundary -ceq $expectedBoundary) 'Actual cold retirement skipped its requested interruption'
                $hash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant()
                $file = [Deployment.WindowsPrivateFile]::Open($marker, $hash)
                try {
                    $identity = $file.CaptureIdentity()
                    if ($coldRetirementManifest) {
                        Assert ($hash -ceq $coldRetirementManifest.sha256 -and
                            $identity.Dev -ceq $coldRetirementManifest.identity.Dev -and
                            $identity.Ino -ceq $coldRetirementManifest.identity.Ino) 'Actual cold retirement replaced its immutable manifest'
                    } else { $coldRetirementManifest = @{ sha256=$hash; identity=$identity } }
                } finally { $file.Dispose() }
                Assert (Test-Path -LiteralPath (Join-Path $control 'lock\owner.json')) 'Actual cold retirement unlocked early'
            }
        }
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
