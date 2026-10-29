function Test-AgentsChatInactiveTask([string]$Source, [string]$TaskName, [string]$Project, [string]$ReadyFile,
    [switch]$Complete, [switch]$Recover,
    [ValidateSet('release-requested', 'lease-released', 'released', 'policy-restore-requested', 'permanent-policy-applied')]
    [string]$RecoveryStep = 'lease-released',
    [ValidateSet('task-restore-requested', 'task-registered', 'task-restored')]
    [string]$RollbackStep = 'task-restored') {
    . (Join-Path $Source 'windows-inactive-task.ps1')
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $task = $folder.GetTask($TaskName)
    $definition = [string]$task.Xml
    $security = [string]$task.GetSecurityDescriptor(7)
    $before = Get-Item -LiteralPath $ReadyFile
    $mtime = $before.LastWriteTimeUtc.Ticks
    $hash = (Get-FileHash -LiteralPath $ReadyFile -Algorithm SHA256).Hash
    $scope = Open-AgentsChatInactiveTask $TaskName $Project
    try {
        $first = Assert-AgentsChatInactiveTask $scope
        Assert ($first.status -ceq 'inactive-task-observed' -and -not $first.runtimeAuthority -and
            $null -eq $first.runtime -and -not $first.retiredRuntime.PSObject.Properties['instanceGuid']) `
            'Inactive observation invented a current runtime or Scheduler instance'
        $second = Assert-AgentsChatInactiveTask $scope
        Assert (($first | ConvertTo-Json -Depth 8 -Compress) -ceq ($second | ConvertTo-Json -Depth 8 -Compress)) `
            'Repeated inactive observation changed'
        $task.Enabled = $true
        $refused = $false
        try { $null = Assert-AgentsChatInactiveTask $scope } catch { $refused = $true }
        Assert $refused 'Inactive scope accepted changed enabled policy'
    } finally {
        $folder.GetTask($TaskName).Enabled = $false
        Close-AgentsChatTaskCompletionProof $scope
    }
    $scope = Open-AgentsChatInactiveTask $TaskName $Project
    try { $null = Assert-AgentsChatInactiveTask $scope }
    finally { Close-AgentsChatTaskCompletionProof $scope }
    $control = "$Project-inactive-control"
    [Deployment.WindowsPrivateFile]::CreateDirectory($control).Dispose()
    $controller = $null
    $copyRecovered = $false
    try {
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $environment.Add('SystemRoot', $env:SystemRoot)
        $environment.Add('TEMP', $control)
        $environment.Add('TMP', $control)
        $environment.Add('PATH', $env:PATH)
        $environment.Add('ComSpec', $env:ComSpec)
        $node = (Get-Command node).Source
        $git = (Get-Command git.exe).Source
        $npmCli = Join-Path (Split-Path $node) 'node_modules/npm/bin/npm-cli.js'
        $controller = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source,
            @((Join-Path $PSScriptRoot 'deployment-windows-inactive-task.mjs'), $Source, $TaskName, $Project,
                [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $control, $git, $npmCli,
                $(if ($Recover) { 'recover' } elseif ($Complete) { 'complete' } else { 'guarded' }),
                $RecoveryStep), $control, $environment)
        $diagnostic = $controller.StandardError.ReadToEndAsync()
        if ($Recover) {
            $held = $null
            $deadline = [DateTime]::UtcNow.AddMinutes(10)
            while (-not $held) {
                Assert ([DateTime]::UtcNow -lt $deadline) 'Inactive completion boundary deadline exceeded'
                $line = $controller.StandardOutput.ReadLineAsync()
                $remaining = [int][Math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
                Assert ($line.Wait($remaining)) 'Inactive completion boundary timed out'
                $text = $line.GetAwaiter().GetResult()
                Assert ($null -ne $text) 'Inactive completion actor exited before boundary'
                Write-Output $text
                if ($text.StartsWith('INACTIVE_COMPLETION_HELD ')) {
                    $held = $text.Substring('INACTIVE_COMPLETION_HELD '.Length) | ConvertFrom-Json
                }
            }
            Assert ($held.step -ceq $RecoveryStep) 'Inactive actor stopped at an unexpected phase'
            $guardedOwner = $null
            $bridge = [Diagnostics.Process]::GetProcessById($held.bridge.pid)
            try {
                if ($RecoveryStep -ceq 'release-requested') {
                    $originalRunning = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-start-running.json') -Raw |
                        ConvertFrom-Json
                    $guardedOwner = [Diagnostics.Process]::GetProcessById($originalRunning.runtime.pid)
                    $null = $guardedOwner.Handle
                    Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($originalRunning.runtime.pid) -ceq
                        $originalRunning.runtime.identity) 'Original guarded runtime identity changed before interruption'
                }
                $null = $bridge.Handle
                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($held.bridge.pid) -ceq
                    $held.bridge.identity) 'Inactive completion bridge identity changed'
                $controller.Kill()
                Assert ($controller.WaitForExit(15000) -and $controller.ExitCode -ne 0) `
                    'Inactive completion actor did not die abruptly'
                Assert ($bridge.WaitForExit(15000)) 'Inactive completion bridge survived actor death'
                if ($guardedOwner) {
                    Assert ($guardedOwner.WaitForExit(30000)) 'Unreleased inactive runtime survived its original controller'
                }
            } finally {
                if ($guardedOwner) { $guardedOwner.Dispose() }
                $bridge.Dispose()
            }
            Assert (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-release-requested.json')) `
                'Inactive completion lost its real release intent'
            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-complete.json'))) `
                'Inactive crash fixture completed before interruption'
            if ($RecoveryStep -ceq 'lease-released') {
                Assert (-not (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-released.json'))) `
                    'Inactive release acknowledgement was published before interruption'
            }
        } else {
            $output = $controller.StandardOutput.ReadToEndAsync()
            Assert ($controller.WaitForExit(600000)) 'Inactive task Node bridge timed out'
            Write-Output $output.GetAwaiter().GetResult()
        }
        $errors = $diagnostic.GetAwaiter().GetResult()
        if ($errors) { [Console]::Error.WriteLine($errors) }
        if (-not $Recover) { Assert ($controller.ExitCode -eq 0) 'Inactive task Node bridge failed' }
        $runningEvidence = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-start-running.json') -Raw |
            ConvertFrom-Json
        $unreleased = $Recover -and $RecoveryStep -ceq 'release-requested'
        if ($unreleased) {
            $preparedEvidence = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-prepared.json') -Raw |
                ConvertFrom-Json
            $runningBefore = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-start-running.json') -Raw |
                ConvertFrom-Json
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty(
                [guid]$runningBefore.runtime.generation, $runningBefore.runtime.sessionId)
            $stateBefore = (Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash
            $refused = $false
            try {
                $unexpected = Open-AgentsChatInactiveCompletionRecovery $control
                Close-AgentsChatTaskCompletionProof $unexpected
            } catch { $refused = $true }
            Assert $refused 'Release intent without actual release granted live completion recovery'
            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash -ceq $stateBefore) `
                'Unreleased recovery refusal changed original accepted state'
            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-released.json'))) `
                'Unreleased recovery refusal fabricated a release receipt'
            Assert ([bool](Get-Command Open-AgentsChatInactiveLostRuntimeEvidence -ErrorAction SilentlyContinue)) `
                'Missing inactive lost-runtime evidence observer'
            $lost = Open-AgentsChatInactiveLostRuntimeEvidence $control
            try {
                $observed = Assert-AgentsChatInactiveLostRuntimeEvidence $lost
                Assert ($observed.status -ceq 'inactive-runtime-lost' -and -not $observed.mutationAuthority -and
                    $observed.phase -ceq 'release-requested' -and $observed.priorRuntime -ceq 'stopped' -and
                    $observed.runtime.identity -ceq $runningBefore.runtime.identity -and
                    $observed.runtime.generation -ceq $runningBefore.runtime.generation) `
                    'Lost-runtime observation differs from actual original stopped history'
                $again = Assert-AgentsChatInactiveLostRuntimeEvidence $lost
                Assert (($observed | ConvertTo-Json -Depth 8 -Compress) -ceq
                    ($again | ConvertTo-Json -Depth 8 -Compress)) 'Lost-runtime evidence changed on recheck'
                $folder.GetTask($TaskName).Enabled = $true
                $refused = $false
                try { $null = Assert-AgentsChatInactiveLostRuntimeEvidence $lost } catch { $refused = $true }
                Assert $refused 'Lost-runtime observer accepted changed task policy'
            } finally {
                $folder.GetTask($TaskName).Enabled = $false
                Close-AgentsChatTaskCompletionProof $lost
            }
            Assert ([bool](Get-Command Open-AgentsChatInactiveLostRuntimeAuthority -ErrorAction SilentlyContinue)) `
                'Missing exclusive inactive lost-runtime authority'
            $authority = Open-AgentsChatInactiveLostRuntimeAuthority $control
            try {
                $observed = Assert-AgentsChatInactiveLostRuntimeEvidence $authority
                Assert (-not $observed.mutationAuthority) 'Exclusive evidence alone granted unscoped mutation authority'
                foreach ($open in @('Open-AgentsChatInactiveLostRuntimeEvidence', 'Open-AgentsChatInactiveLostRuntimeAuthority')) {
                    $refused = $false
                    try {
                        $unexpected = & $open $control
                        Close-AgentsChatTaskCompletionProof $unexpected
                    } catch { $refused = $true }
                    Assert $refused 'Concurrent lost-runtime consumer bypassed retained exclusive history'
                }
                $null = Assert-AgentsChatInactiveLostRuntimeEvidence $authority
            } finally { Close-AgentsChatTaskCompletionProof $authority }
            $authority = Open-AgentsChatInactiveLostRuntimeAuthority $control
            try { $null = Assert-AgentsChatInactiveLostRuntimeEvidence $authority }
            finally { Close-AgentsChatTaskCompletionProof $authority }
            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash -ceq $stateBefore) `
                'Exclusive lost-runtime evidence changed accepted state'
            $crashRollback = [IO.Path]::GetDirectoryName($ReadyFile) -cne $Project
            $lostActor = [Deployment.WindowsControllerProcess]::Start($node,
                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                    $(if ($crashRollback) { 'crash-task' } else { 'crash-project' }), $RollbackStep),
                $control, $environment)
            $copyActorIdentity = if (-not $crashRollback) {
                [Deployment.WindowsWorkerJob]::ProcessIdentity($lostActor.Id)
            } else { $null }
            try {
                $diagnostic = $lostActor.StandardError.ReadToEndAsync()
                if ($crashRollback) {
                    $line = $lostActor.StandardOutput.ReadLineAsync()
                    if (-not $line.Wait(180000)) {
                        $lostActor.Kill()
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        throw "Rollback actor timed out before its actual $RollbackStep boundary"
                    }
                    $held = $line.GetAwaiter().GetResult()
                    if ($null -eq $held) {
                        Assert ($lostActor.WaitForExit(15000)) 'Rollback actor closed output without exiting'
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                    }
                    Assert ($null -ne $held -and $held.StartsWith('INACTIVE_ROLLBACK_TASK_HELD ')) `
                        'Rollback actor exited before its actual task-restored receipt'
                    $identity = $held.Substring('INACTIVE_ROLLBACK_TASK_HELD '.Length) | ConvertFrom-Json
                    Assert ($identity.step -ceq $RollbackStep) 'Rollback actor stopped at a different native boundary'
                    $completedPath = Join-Path $control 'inactive-rollback-task-restored.json'
                    Assert ((Test-Path -LiteralPath $completedPath) -eq ($RollbackStep -ceq 'task-restored')) `
                        'Rollback crash boundary has an unexpected completion receipt'
                    $boundaryDefinition = if ($RollbackStep -ceq 'task-restore-requested') {
                        (Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-prepared.json') -Raw |
                            ConvertFrom-Json).stagedDefinition
                    } else {
                        (Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-task-intent.json') -Raw |
                            ConvertFrom-Json).definition
                    }
                    $boundaryTask = $folder.GetTask($TaskName)
                    Assert (([xml][string]$boundaryTask.Xml).OuterXml -ceq ([xml]$boundaryDefinition).OuterXml -and
                        -not $boundaryTask.Enabled -and $boundaryTask.GetInstances(0).Count -eq 0 -and
                        [string]$boundaryTask.GetSecurityDescriptor(7) -ceq $security) `
                        'Actual rollback policy does not match its held interruption boundary'
                    $bridge = [Diagnostics.Process]::GetProcessById($identity.pid)
                    try {
                        $null = $bridge.Handle
                        Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq $identity.processIdentity) `
                            'Rollback bridge identity changed before interruption'
                        $lostActor.Kill()
                        Assert ($lostActor.WaitForExit(15000) -and $lostActor.ExitCode -ne 0) 'Rollback actor did not die abruptly'
                        Assert ($bridge.WaitForExit(15000)) 'Rollback bridge survived original actor death'
                    } finally { $bridge.Dispose() }
                } else {
                    $output = $lostActor.StandardOutput.ReadToEndAsync()
                    if (-not $lostActor.WaitForExit(300000)) {
                        $lostActor.Kill()
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        throw 'Lost-runtime co-located rollback actor timed out'
                    }
                    Write-Output $output.GetAwaiter().GetResult()
                    Assert ($lostActor.ExitCode -ne 0) 'Co-located copy actor did not actually die'
                }
                $errors = $diagnostic.GetAwaiter().GetResult()
                if ($errors) { [Console]::Error.WriteLine($errors) }
            } finally { $lostActor.Dispose() }
            if (-not $crashRollback) {
                $copy = Get-Content -LiteralPath (Join-Path $control 'inactive-copy-crash-fixture.json') -Raw |
                    ConvertFrom-Json
                $manifest = Join-Path $control 'backup/manifest.json'
                $releaseFile = Join-Path $control 'inactive-rollback-runtime-released.json'
                $snapshot = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
                $files = @($snapshot.entries | Where-Object kind -CEQ 'file')
                Assert ($files.Count -gt 1 -and $copy.version -eq 1 -and $copy.phase -ceq 'project-file-copy' -and
                    $copy.pid -eq $lostActor.Id -and $copy.processIdentity -ceq $copyActorIdentity -and
                    $copy.copiedPath -ceq $files[0].path -and $copy.pendingPath -ceq $files[-1].path) `
                    'Co-located copy interruption differs from the original actor or exact copy boundary'
                Assert-AgentsChatCompletionProcessAbsent $copy.bridge.pid $copy.bridge.processIdentity
                Assert ((Get-FileHash -LiteralPath (Join-Path $Project $copy.copiedPath)).Hash.ToLowerInvariant() -ceq
                    $files[0].sha256 -and -not (Test-Path -LiteralPath (Join-Path $Project $copy.pendingPath))) `
                    'Co-located interruption did not retain an exact copied file and an absent later file'
                Assert ($copy.stateSha256 -ceq $stateBefore.ToLowerInvariant() -and
                    (Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash -ceq $stateBefore -and
                    $copy.snapshotSha256 -ceq (Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant() -and
                    $copy.releaseSha256 -ceq (Get-FileHash -LiteralPath $releaseFile).Hash.ToLowerInvariant() -and
                    -not (Test-Path -LiteralPath (Join-Path $control 'inactive-rollback-files-restored.json'))) `
                    'Co-located copy interruption changed original state/backup/release or fabricated file completion'
                $resumed = [Deployment.WindowsControllerProcess]::Start($node,
                    @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                        $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                        'resume-project', $RollbackStep), $control, $environment)
                try {
                    $output = $resumed.StandardOutput.ReadToEndAsync()
                    $diagnostic = $resumed.StandardError.ReadToEndAsync()
                    if (-not $resumed.WaitForExit(300000)) {
                        $resumed.Kill()
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        Write-Output $output.GetAwaiter().GetResult()
                        throw 'Fresh co-located project copy recovery timed out'
                    }
                    Write-Output $output.GetAwaiter().GetResult()
                    $errors = $diagnostic.GetAwaiter().GetResult()
                    if ($errors) { [Console]::Error.WriteLine($errors) }
                    Assert ($resumed.ExitCode -eq 0) 'Fresh co-located actor could not complete actual interrupted copy'
                } finally { $resumed.Dispose() }
                $copyRecovered = $true
                $crashRollback = $true
                Write-Output 'PASS: co-located project copy survives actual actor death after an exact first file and resumes from durable runtime evidence'
            }
            if ($crashRollback) {
                $terminalStep = if ($copyRecovered) { 'state-staged' } else {
                    switch ($RollbackStep) {
                        'task-restore-requested' { 'state-staged' }
                        'task-registered' { 'state-published' }
                        default { '' }
                    }
                }
                $resumed = [Deployment.WindowsControllerProcess]::Start($node,
                    @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                        $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                        'resume-task', $RollbackStep, $terminalStep),
                    $control, $environment)
                try {
                    $diagnostic = $resumed.StandardError.ReadToEndAsync()
                    if ($terminalStep) {
                        $line = $resumed.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(180000)) 'Terminal rollback actor did not reach publication boundary'
                        $held = $line.GetAwaiter().GetResult()
                        if ($null -eq $held) {
                            Assert ($resumed.WaitForExit(15000)) 'Terminal actor closed output without exiting'
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                        }
                        Assert ($null -ne $held -and $held.StartsWith('INACTIVE_ROLLBACK_TERMINAL_HELD ')) `
                            'Terminal actor exited before the requested publication boundary'
                        $identity = $held.Substring('INACTIVE_ROLLBACK_TERMINAL_HELD '.Length) | ConvertFrom-Json
                        Assert ($identity.step -ceq $terminalStep) 'Terminal actor held a different boundary'
                        $intent = Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-state-intent.json') -Raw |
                            ConvertFrom-Json
                        $expected = if ($terminalStep -ceq 'state-published') { $intent.nextState } else { $intent.oldState }
                        Assert ([IO.File]::ReadAllText((Join-Path $control 'state.json')) -ceq $expected) `
                            'Physical terminal state differs at actual crash boundary'
                        Assert ((Test-Path -LiteralPath (Join-Path $control 'state.json.lock')) -eq
                            ($terminalStep -ceq 'state-staged')) 'Terminal boundary has unexpected staging'
                        $task = $folder.GetTask($TaskName)
                        $taskIntent = Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-task-intent.json') -Raw |
                            ConvertFrom-Json
                        Assert (-not $task.Enabled -and $task.GetInstances(0).Count -eq 0 -and
                            ([xml][string]$task.Xml).OuterXml -ceq ([xml]$taskIntent.definition).OuterXml -and
                            [string]$task.GetSecurityDescriptor(7) -ceq $security) 'Terminal boundary changed stopped task policy'
                        $bridge = [Diagnostics.Process]::GetProcessById($identity.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq $identity.processIdentity) `
                                'Terminal bridge changed before actor interruption'
                            $resumed.Kill()
                            Assert ($resumed.WaitForExit(15000) -and $resumed.ExitCode -ne 0) 'Terminal actor did not die abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Terminal bridge survived actor death'
                        } finally { $bridge.Dispose() }
                    } else {
                        $output = $resumed.StandardOutput.ReadToEndAsync()
                        Assert ($resumed.WaitForExit(120000)) 'Rollback fresh actor reentry timed out'
                        Write-Output $output.GetAwaiter().GetResult()
                        Assert ($resumed.ExitCode -eq 0) 'Rollback fresh actor could not consume actual restored task history'
                    }
                    $errors = $diagnostic.GetAwaiter().GetResult()
                    if ($errors) { [Console]::Error.WriteLine($errors) }
                } finally { $resumed.Dispose() }
                if ($terminalStep) {
                    $terminalActor = [Deployment.WindowsControllerProcess]::Start($node,
                        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                            $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                            'resume-terminal', $RollbackStep, $terminalStep), $control, $environment)
                    try {
                        $diagnostic = $terminalActor.StandardError.ReadToEndAsync()
                        $line = $terminalActor.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(300000)) 'Stopped cleanup actor did not reach actual first deletion'
                        $held = $line.GetAwaiter().GetResult()
                        if ($null -eq $held) {
                            Assert ($terminalActor.WaitForExit(15000)) 'Stopped cleanup closed output without exiting'
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                        }
                        Assert ($null -ne $held -and $held.StartsWith('INACTIVE_ROLLBACK_RETIREMENT_HELD ')) `
                            'Stopped cleanup actor exited before actual deletion'
                        $identity = $held.Substring('INACTIVE_ROLLBACK_RETIREMENT_HELD '.Length) | ConvertFrom-Json
                        Assert ($identity.prefix -eq 1) 'Stopped cleanup actor skipped a deletion prefix'
                        $bridge = [Diagnostics.Process]::GetProcessById($identity.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq $identity.processIdentity) `
                                'Stopped cleanup bridge changed before interruption'
                            $terminalActor.Kill()
                            Assert ($terminalActor.WaitForExit(15000) -and $terminalActor.ExitCode -ne 0) `
                                'Stopped cleanup actor did not die abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Stopped cleanup bridge survived actor death'
                        } finally { $bridge.Dispose() }
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                    } finally { $terminalActor.Dispose() }
                    $retirement = Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-retirement.json') -Raw |
                        ConvertFrom-Json
                    Assert (-not (Test-Path -LiteralPath (Join-Path $control $retirement.entries[0].path))) `
                        'Stopped cleanup interruption did not retain actual first deletion'
                    $remaining = @(Get-ChildItem -LiteralPath (Join-Path $control 'task-maintenance') -Force |
                        Sort-Object Name | ForEach-Object Name)
                    $expected = @($retirement.entries | Select-Object -Skip 1 |
                        ForEach-Object { [IO.Path]::GetFileName($_.path) })
                    Assert (($remaining -join "`n") -ceq ($expected -join "`n")) `
                        'Stopped cleanup interruption changed more than its exact first entry'
                    $fresh = [Deployment.WindowsControllerProcess]::Start($node,
                        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                            $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                            'resume-retirement'), $control, $environment)
                    try {
                        $diagnostic = $fresh.StandardError.ReadToEndAsync()
                        $line = $fresh.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(300000)) 'Stopped worker actor did not reach its actual deletion prefix'
                        $held = $line.GetAwaiter().GetResult()
                        if ($null -eq $held) {
                            Assert ($fresh.WaitForExit(15000)) 'Stopped worker actor closed output without exiting'
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                        }
                        Assert ($null -ne $held -and $held.StartsWith('INACTIVE_ROLLBACK_WORKERS_HELD ')) `
                            'Stopped worker actor exited before actual deletion'
                        $identity = $held.Substring('INACTIVE_ROLLBACK_WORKERS_HELD '.Length) | ConvertFrom-Json
                        Assert ($identity.prefix -eq 2) 'Stopped worker actor skipped its actual deletion boundary'
                        $bridge = [Diagnostics.Process]::GetProcessById($identity.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq $identity.processIdentity) `
                                'Stopped worker bridge changed before interruption'
                            $fresh.Kill()
                            Assert ($fresh.WaitForExit(15000) -and $fresh.ExitCode -ne 0) `
                                'Stopped worker actor did not die abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Stopped worker bridge survived actor death'
                        } finally { $bridge.Dispose() }
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                    } finally { $fresh.Dispose() }
                    $workers = Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-workers.json') -Raw |
                        ConvertFrom-Json
                    for ($index = 0; $index -lt $workers.entries.Count; $index++) {
                        Assert ((Test-Path -LiteralPath (Join-Path $control $workers.entries[$index].path)) -eq ($index -ge 2)) `
                            'Actual stopped worker interruption differs from its exact prefix'
                    }
                    $last = [Deployment.WindowsControllerProcess]::Start($node,
                        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                            $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                            'resume-workers'), $control, $environment)
                    try {
                        $diagnostic = $last.StandardError.ReadToEndAsync()
                        $line = $last.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(300000)) 'Stopped worker actor did not reach actual lock release'
                        $held = $line.GetAwaiter().GetResult()
                        if ($null -eq $held) {
                            Assert ($last.WaitForExit(15000)) 'Stopped worker actor closed output without exiting'
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                        }
                        Assert ($null -ne $held -and $held.StartsWith('INACTIVE_ROLLBACK_WORKERS_RETIRED_HELD ')) `
                            'Stopped worker actor exited before actual lock release'
                        $identity = $held.Substring('INACTIVE_ROLLBACK_WORKERS_RETIRED_HELD '.Length) | ConvertFrom-Json
                        Assert ($identity.prefix -eq $workers.entries.Count) 'Stopped worker actor held wrong final prefix'
                        Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock')) -and
                            -not (Test-Path -LiteralPath (Join-Path $control 'worker-engine')) -and
                            -not (Test-Path -LiteralPath (Join-Path $control 'inactive-rollback-retired.json'))) `
                            'Stopped worker actor did not actually release lock before final receipt'
                        $bridge = [Diagnostics.Process]::GetProcessById($identity.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq $identity.processIdentity) `
                                'Stopped worker final bridge changed before interruption'
                            $last.Kill()
                            Assert ($last.WaitForExit(15000) -and $last.ExitCode -ne 0) `
                                'Stopped worker final actor did not die abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Stopped worker final bridge survived actor death'
                        } finally { $bridge.Dispose() }
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                    } finally { $last.Dispose() }
                    $publisher = [Deployment.WindowsControllerProcess]::Start($node,
                        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                            $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                            'resume-worker-publication'), $control, $environment)
                    try {
                        $output = $publisher.StandardOutput.ReadToEndAsync()
                        $diagnostic = $publisher.StandardError.ReadToEndAsync()
                        Assert ($publisher.WaitForExit(120000)) 'Stopped retirement publication reentry timed out'
                        Write-Output $output.GetAwaiter().GetResult()
                        $errors = $diagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        Assert ($publisher.ExitCode -eq 0) 'Stopped retirement could not resume after actual lock deletion'
                    } finally { $publisher.Dispose() }
                    $historyIntent = Join-Path $control 'inactive-rollback-history-intent.json'
                    $history = Get-Content -LiteralPath $historyIntent -Raw | ConvertFrom-Json
                    $historyHash = (Get-FileHash -LiteralPath $historyIntent -Algorithm SHA256).Hash
                    $historyStateHash = (Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash
                    $historyBoundaries = @('history', 'finalized-history', 'saved-history', 'completed-history', 'prepared-history', 'abandoned-history',
                        'lock-directory-history', 'lock-owner-history', 'lock-committed-history', 'lock-retirement-history', 'lock-owner-retired-history', 'lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')
                    $historyShard = $env:DEPLOYMENT_TEST_HISTORY_SHARD
                    if ([string]::IsNullOrEmpty($historyShard)) { $historyShard = 'all' }
                    if ($historyShard -cnotin @('all', 'baseline', 'successor', 'restart', 'commitment')) { throw 'Unknown stopped-history test shard.' }
                    $successorIndex = [Array]::IndexOf($historyBoundaries, 'successor-prepared-history')
                    $restartIndex = [Array]::IndexOf($historyBoundaries, 'restart-directory-history')
                    $commitmentIndex = [Array]::IndexOf($historyBoundaries, 'restart-committed-history')
                    if ($successorIndex -le 0 -or $restartIndex -le $successorIndex -or $commitmentIndex -le $restartIndex) {
                        throw 'Stopped-history shard boundary is missing.'
                    }
                    $selectedBoundaries = switch -CaseSensitive ($historyShard) {
                        'all' { $historyBoundaries }
                        'baseline' { $historyBoundaries[0..($successorIndex - 1)] }
                        'successor' { $historyBoundaries[$successorIndex..($restartIndex - 1)] }
                        'restart' { $historyBoundaries[$restartIndex..($commitmentIndex - 1)] }
                        'commitment' { $historyBoundaries[$commitmentIndex..($historyBoundaries.Count - 1)] }
                    }
                    foreach ($historyBoundary in $selectedBoundaries) {
                        $lockBoundary = $historyBoundary -cin @('lock-directory-history', 'lock-owner-history', 'lock-committed-history', 'lock-retirement-history', 'lock-owner-retired-history', 'lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')
                        $crashMode = switch ($historyBoundary) {
                            'finalized-history' { 'crash-finalized-history' }
                            'completed-history' { 'crash-completed-history' }
                            'prepared-history' { 'crash-prepared-history' }
                            'abandoned-history' { 'crash-prepared-history' }
                            'lock-retirement-history' { 'crash-lock-committed-history' }
                            'lock-owner-retired-history' { 'crash-lock-committed-history' }
                            'lock-directory-retired-history' { 'crash-lock-committed-history' }
                            'lock-settled-history' { 'crash-lock-committed-history' }
                            'successor-prepared-history' { 'crash-lock-committed-history' }
                            'successor-abandoned-history' { 'crash-lock-committed-history' }
                            'restart-published-history' { 'crash-lock-committed-history' }
                            'restart-prepared-history' { 'crash-lock-committed-history' }
                            'restart-directory-history' { 'crash-lock-committed-history' }
                            'restart-directory-dead-history' { 'crash-lock-committed-history' }
                            'restart-owner-history' { 'crash-lock-committed-history' }
                            'restart-owner-dead-history' { 'crash-lock-committed-history' }
                            'restart-committed-history' { 'crash-lock-committed-history' }
                            'restart-committed-dead-history' { 'crash-lock-committed-history' }
                            'restart-state-intent-history' { 'crash-lock-committed-history' }
                            'restart-state-written-history' { 'crash-lock-committed-history' }
                            { $lockBoundary -and $_ -cnotin @('lock-retirement-history', 'lock-owner-retired-history', 'lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history') } { "crash-$historyBoundary" }
                            default { 'crash-history' }
                        }
                        $resumeMode = if ($historyBoundary -ceq 'saved-history') { 'resume-history-saved' } else { "resume-$historyBoundary" }
                        $archiver = [Deployment.WindowsControllerProcess]::Start($node,
                            @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                $crashMode), $control, $environment)
                        try {
                            $diagnostic = $archiver.StandardError.ReadToEndAsync()
                            $line = $archiver.StandardOutput.ReadLineAsync()
                            Assert ($line.Wait(120000)) 'History writer did not reach its actual archived prefix'
                            $text = $line.GetAwaiter().GetResult()
                            if ($null -eq $text) {
                                Assert ($archiver.WaitForExit(15000)) 'History writer closed output without exiting'
                                [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                            }
                            Assert ($null -ne $text -and $text.StartsWith('INACTIVE_HISTORY_ARCHIVE_HELD ')) `
                                'History writer exited before its held native archive'
                            $historyActor = $text.Substring('INACTIVE_HISTORY_ARCHIVE_HELD '.Length)
                            $held = $historyActor | ConvertFrom-Json
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($held.pid) -ceq $held.processIdentity) `
                                'History writer did not retain its original native bridge'
                            $bridge = [Diagnostics.Process]::GetProcessById($held.pid)
                            try {
                                $null = $bridge.Handle
                                $archiver.Kill()
                                Assert ($archiver.WaitForExit(15000)) 'History writer survived actual actor death'
                                Assert ($bridge.WaitForExit(15000)) 'History bridge survived original actor death'
                            } finally { $bridge.Dispose() }
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                        } finally { $archiver.Dispose() }
                        $entry = $history.entries[0]
                        Assert (-not (Test-Path -LiteralPath (Join-Path $control $entry.path))) `
                            'Writer death restored the original history pathname'
                        Assert ((Get-FileHash -LiteralPath (Join-Path $control $entry.destination) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $entry.sha256) `
                            'Writer death lost the exact archived original'
                        if ($lockBoundary -or $historyBoundary -cin @('finalized-history', 'completed-history', 'prepared-history', 'abandoned-history')) {
                            Assert (-not (Test-Path -LiteralPath $historyIntent)) 'Finalized actor death restored active intent'
                            $archivedIntent = Join-Path $control "retired-$($history.operationId)-inactive-rollback-history-intent.json"
                            Assert ((Get-FileHash -LiteralPath $archivedIntent -Algorithm SHA256).Hash -ceq $historyHash) `
                                'Finalized actor death lost the original archived intent'
                        }
                        if ($lockBoundary -or $historyBoundary -cin @('completed-history', 'prepared-history', 'abandoned-history')) {
                            $completed = Join-Path $control "retired-$($history.operationId)-inactive-rollback-history-complete.json"
                            Assert ((Get-FileHash -LiteralPath $completed -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $held.completionSha256) `
                                'Completion publisher death changed the original completion receipt'
                        }
                        if ($lockBoundary -or $historyBoundary -cin @('prepared-history', 'abandoned-history')) {
                            Assert ($held.attemptId -cmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -and
                                $held.prepared.path -ceq "inactive-handoff-$($held.attemptId)-prepared.json") `
                                'Preparation publisher descriptor is not bound to its exact attempt'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control $held.prepared.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $held.prepared.sha256) `
                                'Preparation publisher death changed the original prepared record'
                        }
                        if ($historyBoundary -ceq 'abandoned-history') {
                            $abandoner = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-abandoned-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $abandoner.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $abandoner.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Abandonment publisher did not reach its held boundary'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($abandoner.WaitForExit(15000)) 'Abandonment publisher closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Abandonment publisher exited before held publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_ABANDONED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Abandonment publisher readiness exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_ABANDONED_HELD '.Length)
                                $abandonedHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($abandonedHeld.pid) -ceq
                                    $abandonedHeld.processIdentity) 'Abandonment publisher native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($abandonedHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $abandoner.Kill()
                                    Assert ($abandoner.WaitForExit(15000)) 'Abandonment publisher survived actual actor death'
                                    Assert ($bridge.WaitForExit(15000)) 'Abandonment native bridge survived actor death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $abandoner.Dispose() }
                            foreach ($descriptor in @($abandonedHeld.prepared, $abandonedHeld.terminal)) {
                                Assert ((Get-FileHash -LiteralPath (Join-Path $control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                    $descriptor.sha256) 'Abandonment publisher death changed retained handoff evidence'
                            }
                            Assert ((Get-FileHash -LiteralPath $completed -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                $abandonedHeld.completionSha256) 'Abandonment publisher death changed original completion receipt'
                            $resumeMode = 'resume-abandoned-history'
                        }
                        if ($historyBoundary -cin @('lock-retirement-history', 'lock-owner-retired-history', 'lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $retirer = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-lock-retirement-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $retirer.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $retirer.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Lock retirement publisher did not reach its held boundary'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($retirer.WaitForExit(15000)) 'Lock retirement publisher closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Lock retirement publisher exited before held publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_LOCK_RETIREMENT_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Lock retirement publisher exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_LOCK_RETIREMENT_HELD '.Length)
                                $retirementHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($retirementHeld.pid) -ceq
                                    $retirementHeld.processIdentity) 'Lock retirement publisher native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($retirementHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $retirer.Kill()
                                    Assert ($retirer.WaitForExit(15000)) 'Lock retirement publisher survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Lock retirement native bridge survived actor death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $retirer.Dispose() }
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control $retirementHeld.retirement.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                $retirementHeld.retirement.sha256) 'Publisher death changed exact lock retirement intent'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Lock retirement publisher death changed original state'
                            $resumeMode = 'resume-lock-retirement-history'
                        }
                        if ($historyBoundary -cin @('lock-owner-retired-history', 'lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $executor = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-lock-owner-retired-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $executor.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $executor.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Owner retirement executor did not reach actual deletion'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($executor.WaitForExit(15000)) 'Owner retirement executor closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Owner retirement executor exited before held deletion'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_OWNER_RETIRED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Owner retirement executor exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_OWNER_RETIRED_HELD '.Length)
                                $ownerRetiredHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($ownerRetiredHeld.pid) -ceq
                                    $ownerRetiredHeld.processIdentity) 'Owner retirement native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($ownerRetiredHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $executor.Kill()
                                    Assert ($executor.WaitForExit(15000)) 'Owner retirement executor survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Owner retirement native bridge survived executor death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $executor.Dispose() }
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock\owner.json'))) `
                                'Native owner deletion did not persist after actual executor death'
                            Assert (@(Get-ChildItem -LiteralPath (Join-Path $control 'lock') -Force).Count -eq 0) `
                                'Owner deletion left an unexpected directory child'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Owner retirement executor death changed original state'
                            $resumeMode = 'resume-lock-owner-retired-history'
                        }
                        if ($historyBoundary -cin @('lock-directory-retired-history', 'lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $directoryExecutor = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-lock-directory-retired-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $directoryExecutor.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $directoryExecutor.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Directory retirement executor did not reach actual deletion'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($directoryExecutor.WaitForExit(15000)) 'Directory executor closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Directory retirement executor exited before held deletion'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_DIRECTORY_RETIRED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Directory retirement executor exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_DIRECTORY_RETIRED_HELD '.Length)
                                $directoryRetiredHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($directoryRetiredHeld.pid) -ceq
                                    $directoryRetiredHeld.processIdentity) 'Directory retirement native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($directoryRetiredHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $directoryExecutor.Kill()
                                    Assert ($directoryExecutor.WaitForExit(15000)) 'Directory executor survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Directory retirement native bridge survived executor death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $directoryExecutor.Dispose() }
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) `
                                'Native directory deletion did not persist after actual executor death'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Directory executor death changed original state'
                            $resumeMode = 'resume-lock-directory-retired-history'
                        }
                        if ($historyBoundary -cin @('lock-settled-history', 'successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $settler = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-lock-settled-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $settler.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $settler.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Lock settler did not reach actual terminal publication'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($settler.WaitForExit(15000)) 'Lock settler closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Lock settler exited before held terminal publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_LOCK_SETTLED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Lock settler exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_LOCK_SETTLED_HELD '.Length)
                                $settledHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($settledHeld.pid) -ceq
                                    $settledHeld.processIdentity) 'Lock settlement native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($settledHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $settler.Kill()
                                    Assert ($settler.WaitForExit(15000)) 'Lock settler survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Lock settlement native bridge survived publisher death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $settler.Dispose() }
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control $settledHeld.terminal.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                $settledHeld.terminal.sha256) 'Settler death changed original terminal record'
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Settler death restored the retired lock'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Settler death changed original state'
                            $resumeMode = 'resume-lock-settled-history'
                        }
                        if ($historyBoundary -cin @('successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $successorPublisher = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-successor-prepared-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $successorPublisher.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $successorPublisher.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Successor publisher did not reach actual preparation publication'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($successorPublisher.WaitForExit(15000)) 'Successor publisher closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Successor publisher exited before held preparation publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_SUCCESSOR_PREPARED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Successor publisher exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_SUCCESSOR_PREPARED_HELD '.Length)
                                $successorHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($successorHeld.pid) -ceq
                                    $successorHeld.processIdentity) 'Successor publisher native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($successorHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $successorPublisher.Kill()
                                    Assert ($successorPublisher.WaitForExit(15000)) 'Successor publisher survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Successor bridge survived actual publisher death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $successorPublisher.Dispose() }
                            foreach ($descriptor in @($successorHeld.prepared, $successorHeld.committed,
                                $successorHeld.retirement, $successorHeld.terminal, $successorHeld.successor)) {
                                Assert ((Get-FileHash -LiteralPath (Join-Path $control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                    $descriptor.sha256) 'Successor publisher death changed immutable evidence'
                            }
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Successor publisher death restored the retired lock'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Successor publisher death changed original state'
                            $resumeMode = 'resume-successor-prepared-history'
                        }
                        if ($historyBoundary -ceq 'lock-owner-retired-history') {
                            $ownerChecker = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'check-lock-owner-retired-history', $historyActor), $control, $environment)
                            try {
                                $output = $ownerChecker.StandardOutput.ReadToEndAsync()
                                $diagnostic = $ownerChecker.StandardError.ReadToEndAsync()
                                Assert ($ownerChecker.WaitForExit(120000)) 'Fresh owner-retired proof actor timed out'
                                Write-Output $output.GetAwaiter().GetResult()
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                                Assert ($ownerChecker.ExitCode -eq 0) 'Fresh owner-retired proof actor failed'
                            } finally { $ownerChecker.Dispose() }
                        }
                        if ($historyBoundary -ceq 'lock-settled-history') {
                            $settlementChecker = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'check-lock-settled-history', $historyActor), $control, $environment)
                            try {
                                $output = $settlementChecker.StandardOutput.ReadToEndAsync()
                                $diagnostic = $settlementChecker.StandardError.ReadToEndAsync()
                                Assert ($settlementChecker.WaitForExit(120000)) 'Fresh settlement proof actor timed out'
                                Write-Output $output.GetAwaiter().GetResult()
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                                Assert ($settlementChecker.ExitCode -eq 0) 'Fresh settlement proof actor failed'
                            } finally { $settlementChecker.Dispose() }
                        }
                        if ($historyBoundary -cin @('successor-prepared-history', 'successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $successorChecker = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'check-successor-prepared-history', $historyActor), $control, $environment)
                            try {
                                $output = $successorChecker.StandardOutput.ReadToEndAsync()
                                $diagnostic = $successorChecker.StandardError.ReadToEndAsync()
                                Assert ($successorChecker.WaitForExit(120000)) 'Fresh successor proof actor timed out'
                                $successorProofOutput = $output.GetAwaiter().GetResult()
                                Write-Output $successorProofOutput
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                                Assert ($successorChecker.ExitCode -eq 0) 'Fresh successor proof actor failed'
                                $successorProofFrames = @($successorProofOutput -split '\r?\n' |
                                    Where-Object { $_.StartsWith('INACTIVE_HISTORY_SUCCESSOR_OBSERVED ') })
                                Assert ($successorProofFrames.Count -eq 1) 'Fresh successor proof identity frame differs'
                                $historyActor = $successorProofFrames[0].Substring('INACTIVE_HISTORY_SUCCESSOR_OBSERVED '.Length)
                            } finally { $successorChecker.Dispose() }
                        }
                        if ($historyBoundary -cin @('successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $abandoner = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-successor-abandoned-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $abandoner.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $abandoner.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Successor abandoner did not publish its actual terminal'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($abandoner.WaitForExit(15000)) 'Successor abandoner closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Successor abandoner exited before held terminal publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_SUCCESSOR_ABANDONED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Successor abandoner exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_SUCCESSOR_ABANDONED_HELD '.Length)
                                $abandonedHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($abandonedHeld.pid) -ceq
                                    $abandonedHeld.processIdentity) 'Successor abandoner native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($abandonedHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $abandoner.Kill()
                                    Assert ($abandoner.WaitForExit(15000)) 'Successor abandoner survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Successor abandoner bridge survived actual publisher death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $abandoner.Dispose() }
                            foreach ($descriptor in @($abandonedHeld.prepared, $abandonedHeld.committed,
                                $abandonedHeld.retirement, $abandonedHeld.terminal, $abandonedHeld.successor,
                                $abandonedHeld.successorAbandoned)) {
                                Assert ((Get-FileHash -LiteralPath (Join-Path $control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                    $descriptor.sha256) 'Successor abandoner death changed immutable evidence'
                            }
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Successor abandoner death restored the retired lock'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Successor abandoner death changed original state'
                            $resumeMode = if ($historyBoundary -ceq 'restart-directory-history') {
                                'resume-restart-directory-history'
                            } elseif ($historyBoundary -ceq 'restart-owner-history') {
                                'resume-restart-owner-history'
                            } elseif ($historyBoundary -ceq 'restart-committed-history') {
                                'resume-restart-committed-history'
                            } elseif ($historyBoundary -ceq 'restart-state-intent-history') {
                                'resume-restart-state-intent-history'
                            } elseif ($historyBoundary -ceq 'restart-state-written-history') {
                                'resume-restart-state-written-history'
                            } elseif ($historyBoundary -ceq 'restart-published-history') {
                                'resume-restart-published-history'
                            } else { 'resume-successor-abandoned-history' }
                        }
                        if ($historyBoundary -cin @('successor-abandoned-history', 'restart-published-history', 'restart-prepared-history', 'restart-directory-history', 'restart-directory-dead-history', 'restart-owner-history', 'restart-owner-dead-history', 'restart-committed-history', 'restart-committed-dead-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                            $settledChecker = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'check-successor-abandoned-history', $historyActor), $control, $environment)
                            try {
                                $output = $settledChecker.StandardOutput.ReadToEndAsync()
                                $diagnostic = $settledChecker.StandardError.ReadToEndAsync()
                                Assert ($settledChecker.WaitForExit(120000)) 'Fresh six-record proof actor timed out'
                                $settledProofOutput = $output.GetAwaiter().GetResult()
                                Write-Output $settledProofOutput
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                                Assert ($settledChecker.ExitCode -eq 0) 'Fresh six-record proof actor failed'
                                $settledProofFrames = @($settledProofOutput -split '\r?\n' |
                                    Where-Object { $_.StartsWith('INACTIVE_HISTORY_SUCCESSOR_ABANDONED_OBSERVED ') })
                                Assert ($settledProofFrames.Count -eq 1) 'Fresh six-record proof identity frame differs'
                                $historyActor = $settledProofFrames[0].Substring('INACTIVE_HISTORY_SUCCESSOR_ABANDONED_OBSERVED '.Length)
                            } finally { $settledChecker.Dispose() }
                        }
                        if ($historyBoundary -ceq 'restart-prepared-history') {
                            $restartPublisher = [Deployment.WindowsControllerProcess]::Start($node,
                                @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                    $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                    'crash-restart-prepared-history', $historyActor), $control, $environment)
                            try {
                                $diagnostic = $restartPublisher.StandardError.ReadToEndAsync()
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $restartPublisher.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Restart publisher did not publish its actual preparation'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($restartPublisher.WaitForExit(15000)) 'Restart publisher closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Restart publisher exited before held preparation publication'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_RESTART_PREPARED_HELD ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Restart publisher exceeded actor budget'
                                }
                                $historyActor = $text.Substring('INACTIVE_HISTORY_RESTART_PREPARED_HELD '.Length)
                                $restartHeld = $historyActor | ConvertFrom-Json
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($restartHeld.pid) -ceq
                                    $restartHeld.processIdentity) 'Restart publisher native bridge changed'
                                $bridge = [Diagnostics.Process]::GetProcessById($restartHeld.pid)
                                try {
                                    $null = $bridge.Handle
                                    $restartPublisher.Kill()
                                    Assert ($restartPublisher.WaitForExit(15000)) 'Restart publisher survived actual death'
                                    Assert ($bridge.WaitForExit(15000)) 'Restart bridge survived actual publisher death'
                                } finally { $bridge.Dispose() }
                                $errors = $diagnostic.GetAwaiter().GetResult()
                                if ($errors) { [Console]::Error.WriteLine($errors) }
                            } finally { $restartPublisher.Dispose() }
                            foreach ($descriptor in @($restartHeld.prepared, $restartHeld.committed,
                                $restartHeld.retirement, $restartHeld.terminal, $restartHeld.successor,
                                $restartHeld.successorAbandoned, $restartHeld.restartPrepared)) {
                                Assert ((Get-FileHash -LiteralPath (Join-Path $control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                    $descriptor.sha256) 'Restart publisher death changed immutable evidence'
                            }
                            Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Restart publisher death restored the retired lock'
                            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq
                                $historyStateHash) 'Restart publisher death changed original state'
                            $resumeMode = 'resume-restart-prepared-history'
                        }
                        if ($historyBoundary -cin @('restart-directory-dead-history', 'restart-owner-dead-history', 'restart-committed-dead-history')) {
                            . (Join-Path $PSScriptRoot 'deployment-windows-restart-directory-death.ps1')
                            $historyActor = Stop-AgentsChatRestartDirectoryPublisher $node $Source $control `
                                ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) `
                                $environment $historyActor $historyStateHash -Owner:($historyBoundary -ceq 'restart-owner-dead-history') `
                                -Committed:($historyBoundary -ceq 'restart-committed-dead-history')
                            $resumeMode = "resume-$historyBoundary"
                        }
                        $historyResumer = [Deployment.WindowsControllerProcess]::Start($node,
                            @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
                                $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName,
                                $resumeMode, $historyActor), $control, $environment)
                        try {
                            $diagnostic = $historyResumer.StandardError.ReadToEndAsync()
                            if ($historyBoundary -cin @('restart-directory-history', 'restart-owner-history', 'restart-committed-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                                $clock = [Diagnostics.Stopwatch]::StartNew()
                                while ($true) {
                                    $line = $historyResumer.StandardOutput.ReadLineAsync()
                                    $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
                                    Assert ($line.Wait([int]$remaining)) 'Live restart publication stage timed out'
                                    $text = $line.GetAwaiter().GetResult()
                                    if ($null -eq $text) {
                                        Assert ($historyResumer.WaitForExit(15000)) 'Live restart publisher closed output without exiting'
                                        [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                                        throw 'Live restart publisher exited before directory checkpoint'
                                    }
                                    if ($text.StartsWith('INACTIVE_HISTORY_RESTART_PREPARED_LIVE ')) { break }
                                    Write-Output $text
                                    Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart publication stage exceeded budget'
                                }
                                $live = $text.Substring('INACTIVE_HISTORY_RESTART_PREPARED_LIVE '.Length) | ConvertFrom-Json
                                Assert ($live.actorPid -eq $historyResumer.Id -and
                                    [Deployment.WindowsWorkerJob]::ProcessIdentity($live.actorPid) -ceq $live.actorIdentity -and
                                    [Deployment.WindowsWorkerJob]::ProcessIdentity($live.pid) -ceq $live.processIdentity) `
                                    'Restart directory checkpoint lost its actual live owner or bridge'
                                Assert ((Get-FileHash -LiteralPath (Join-Path $control $live.prepared.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                                    $live.prepared.sha256) 'Restart directory checkpoint preparation changed'
                                Assert (-not (Test-Path -LiteralPath (Join-Path $control 'lock'))) 'Restart directory appeared before explicit command'
                                $historyResumer.StandardInput.WriteLine('{"type":"create-directory"}')
                                $historyResumer.StandardInput.Flush()
                            }
                            if ($historyBoundary -cin @('restart-owner-history', 'restart-committed-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                                . (Join-Path $PSScriptRoot 'deployment-windows-restart-owner-controller.ps1')
                                Send-AgentsChatRestartOwnerCommand $historyResumer $diagnostic $live $control
                            }
                            if ($historyBoundary -cin @('restart-committed-history', 'restart-state-intent-history', 'restart-state-written-history')) {
                                . (Join-Path $PSScriptRoot 'deployment-windows-restart-commit-controller.ps1')
                                Send-AgentsChatRestartCommitCommand $historyResumer $diagnostic $live $control
                            }
                            if ($historyBoundary -cin @('restart-state-intent-history', 'restart-state-written-history')) {
                                . (Join-Path $PSScriptRoot 'deployment-windows-restart-state-intent-controller.ps1')
                                Send-AgentsChatRestartStateIntentCommand $historyResumer $diagnostic $live $control
                            }
                            if ($historyBoundary -ceq 'restart-state-written-history') {
                                . (Join-Path $PSScriptRoot 'deployment-windows-restart-state-write-controller.ps1')
                                Send-AgentsChatRestartStateWriteCommand $historyResumer $diagnostic $live $control
                            }
                            $output = $historyResumer.StandardOutput.ReadToEndAsync()
                            Assert ($historyResumer.WaitForExit(120000)) 'Fresh history actor takeover timed out'
                            Write-Output $output.GetAwaiter().GetResult()
                            $errors = $diagnostic.GetAwaiter().GetResult()
                            if ($errors) { [Console]::Error.WriteLine($errors) }
                            Assert ($historyResumer.ExitCode -eq 0) 'Fresh actor could not resume actual history archival'
                        } finally { $historyResumer.Dispose() }
                        Assert ((Get-FileHash -LiteralPath $historyIntent -Algorithm SHA256).Hash -ceq $historyHash -and
                            (Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq $historyStateHash) `
                            'History actor takeover changed prepared intent or original state'
                    }
                    if ($historyShard -cin @('all', 'baseline')) {
                        Write-Output 'PASS: actual history writer death preserves its archived prefix and a distinct fresh actor completes exact native archival'
                        Write-Output 'PASS: death after final intent archival retains sealed evidence for a distinct fresh read-only actor'
                        Write-Output 'PASS: the exact verified saved entry resumes stopped history archival after actual actor death'
                        Write-Output 'PASS: completion publisher death preserves original receipt bytes and identity for a distinct fresh actor'
                        Write-Output 'PASS: stopped task and worker cleanup survive real actor death, retire exact history, release original lock and retain final receipt'
                    }
                }
            }
            $Recover = $false
            $Complete = $false
            Write-Output 'PASS: actual pre-release controller death settles guarded runtime; release intent alone cannot authorize released recovery'
        }
        if ($Recover) {
            Assert ([bool](Get-Command Open-AgentsChatInactiveCompletionRecovery -ErrorAction SilentlyContinue)) `
                'Missing inactive released-prefix completion recovery'
            $refused = $false
            try {
                $unexpected = Open-AgentsChatInactiveCompletionProof $control
                Close-AgentsChatTaskCompletionProof $unexpected
            } catch { $refused = $true }
            Assert $refused 'Complete inactive proof accepted an interrupted prefix'
            function Invoke-InactiveRecoveryActor([string]$Mode) {
                $actor = [Deployment.WindowsControllerProcess]::Start($node,
                    @((Join-Path $PSScriptRoot 'deployment-windows-inactive-recovery-session.mjs'),
                        $Source, $control, [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $Mode),
                    $control, $environment)
                try {
                    $actorErrors = $actor.StandardError.ReadToEndAsync()
                    if ($Mode -ceq 'crash') {
                        $line = $actor.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(120000)) 'Inactive recovery actor did not reach its held boundary'
                        $text = $line.GetAwaiter().GetResult()
                        Assert ($null -ne $text -and $text.StartsWith('INACTIVE_RECOVERY_HELD ')) `
                            'Inactive recovery actor did not report its real held boundary'
                        $held = $text.Substring('INACTIVE_RECOVERY_HELD '.Length) | ConvertFrom-Json
                        Assert ($held.step -ceq 'released') 'Inactive recovery actor held the wrong phase'
                        $helpers = [Collections.Generic.List[Diagnostics.Process]]::new()
                        try {
                            foreach ($identity in @($held.bridge, $held.admission)) {
                                $helper = [Diagnostics.Process]::GetProcessById($identity.pid)
                                $helpers.Add($helper)
                                $null = $helper.Handle
                                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($identity.pid) -ceq
                                    $identity.processIdentity) 'Inactive recovery helper identity changed'
                            }
                            $helpers[1].Kill()
                            Assert ($helpers[1].WaitForExit(15000)) 'Original inactive recovery admission did not exit'
                            Invoke-InactiveRecoveryActor 'refuse'
                            Assert (-not $helpers[0].HasExited -and
                                [Deployment.WindowsWorkerJob]::ProcessIdentity($held.bridge.pid) -ceq
                                $held.bridge.processIdentity) 'Admission loss terminated or replaced the retained recovery bridge'
                            $actor.Kill()
                            Assert ($actor.WaitForExit(15000) -and $actor.ExitCode -ne 0) `
                                'Inactive recovery actor did not terminate abruptly'
                            foreach ($helper in $helpers) {
                                Assert ($helper.WaitForExit(15000)) 'Inactive recovery helper survived actor death'
                            }
                        } finally { foreach ($helper in $helpers) { $helper.Dispose() } }
                        Assert (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-released.json')) `
                            'Interrupted recovery lost its published receipt'
                        Assert (-not (Test-Path -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-policy-restore-requested.json'))) `
                            'Interrupted recovery advanced beyond its held boundary'
                        Write-Output 'PASS: actual inactive recovery actor death settles both original helpers and retains the acknowledged released prefix'
                    } else {
                        $actorOutput = $actor.StandardOutput.ReadToEndAsync()
                        Assert ($actor.WaitForExit(120000)) 'Inactive recovery transport actor timed out'
                        Write-Output $actorOutput.GetAwaiter().GetResult()
                    }
                    $errors = $actorErrors.GetAwaiter().GetResult()
                    if ($errors) { [Console]::Error.WriteLine($errors) }
                    if ($Mode -cne 'crash') { Assert ($actor.ExitCode -eq 0) 'Inactive recovery transport actor failed' }
                } finally { $actor.Dispose() }
            }
            Invoke-InactiveRecoveryActor 'inspect'
            $stateBefore = (Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash
            $recovery = Open-AgentsChatInactiveCompletionRecovery $control
            try {
                $refused = $false
                try {
                    $unexpected = Open-AgentsChatInactiveCompletionRecovery $control
                    Close-AgentsChatTaskCompletionProof $unexpected
                } catch { $refused = $true }
                Assert $refused 'Concurrent inactive completion recovery was admitted'
                $observed = Assert-AgentsChatInactiveCompletionRecovery $recovery
                $phase = switch ($RecoveryStep) {
                    'lease-released' { 'release-requested' }
                    'permanent-policy-applied' { 'policy-restore-requested' }
                    default { $RecoveryStep }
                }
                $initialStep = if ($RecoveryStep -ceq 'lease-released') { 'release-requested' } else { $RecoveryStep }
                if ($RecoveryStep -ceq 'policy-restore-requested') {
                    $prepared = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-complete-prepared.json') -Raw |
                        ConvertFrom-Json
                    $actualPolicy = ([xml][string]$folder.GetTask($TaskName).Xml).OuterXml
                    if ($actualPolicy -ceq ([xml]$prepared.definition).OuterXml) {
                        $initialStep = 'permanent-policy-applied'
                    } else {
                        Assert ($actualPolicy -ceq ([xml]$prepared.stagedDefinition).OuterXml) `
                            'Interrupted inactive task has neither staged nor permanent policy'
                    }
                }
                Assert ($observed.phase -ceq $phase -and $observed.step -ceq $initialStep -and $observed.lease -ceq 'released') `
                    "Inactive recovery differs: expected $phase/$initialStep/released, observed $($observed.phase)/$($observed.step)/$($observed.lease)"
                $steps = @('release-requested', 'released', 'policy-restore-requested', 'permanent-policy-applied', 'complete')
                $index = [Array]::IndexOf($steps, $initialStep)
                Assert ($index -ge 0 -and $index -lt 4) 'Unexpected inactive recovery starting step'
                if ($RecoveryStep -cin @('lease-released', 'permanent-policy-applied')) {
                    Close-AgentsChatTaskCompletionProof $recovery
                    if ($RecoveryStep -ceq 'lease-released') { Invoke-InactiveRecoveryActor 'crash' }
                    Invoke-InactiveRecoveryActor 'advance'
                    $recovery = Open-AgentsChatInactiveCompletionRecovery $control
                    $observed = Assert-AgentsChatInactiveCompletionRecovery $recovery
                } else { foreach ($step in $steps[($index + 1)..4]) {
                    $observed = Advance-AgentsChatInactiveCompletionRecovery $recovery
                    Assert ($observed.step -ceq $step) 'Inactive recovery acknowledged an unexpected phase'
                    if ($step -ceq 'released') {
                        Close-AgentsChatTaskCompletionProof $recovery
                        $recovery = Open-AgentsChatInactiveCompletionRecovery $control
                        $observed = Assert-AgentsChatInactiveCompletionRecovery $recovery
                        Assert ($observed.phase -ceq 'released') 'Reopened inactive recovery lost its durable prefix'
                    } }
                }
                Assert ($observed.status -ceq 'complete') 'Inactive recovery did not complete'
            } finally { Close-AgentsChatTaskCompletionProof $recovery }
            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash -ceq $stateBefore) `
                'Inactive recovery changed accepted state'
            Write-Output "PASS: inactive released-prefix recovery at $RecoveryStep survives original actor death, refuses concurrent takeover and retains its real durable prefix"
        }
        $state = Get-Content -LiteralPath (Join-Path $control 'state.json') -Raw | ConvertFrom-Json
        $expectedBundle = Join-Path $control "runtime-$($state.operationId)"
        $running = $runningEvidence
        $finalDefinition = $running.definition
        if ($unreleased) {
            $prepared = $preparedEvidence
            $finalDefinition = [string]$folder.GetTask($TaskName).Xml
            if ([IO.Path]::GetDirectoryName($ReadyFile) -cne $Project -or
                (Test-Path -LiteralPath (Join-Path $control 'inactive-rollback-runtime-released.json'))) {
                $rollback = Get-Content -LiteralPath (Join-Path $control 'inactive-rollback-task-restored.json') -Raw |
                    ConvertFrom-Json
                $original = [xml]$definition
                $namespaces = [Xml.XmlNamespaceManager]::new($original.NameTable)
                $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
                $bundle = Join-Path $control 'inactive-rollback-runtime'
                $configuration = Join-Path $bundle 'configuration.json'
                $sha256 = (Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant()
                $original.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces).InnerText = `
                    "-NoProfile -NonInteractive -File `"$(Join-Path $bundle 'windows-runtime-host.ps1')`" -Configuration `"$configuration`" -Sha256 $sha256"
                $original.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:WorkingDirectory', $namespaces).InnerText = $bundle
                Assert ($rollback.phase -ceq 'task-restored' -and
                    ([xml]$finalDefinition).OuterXml -ceq $original.OuterXml -and
                    ([xml]$rollback.definition).OuterXml -ceq $original.OuterXml -and
                    -not $folder.GetTask($TaskName).Enabled -and
                    $folder.GetTask($TaskName).GetInstances(0).Count -eq 0) `
                    'Rollback did not restore original stopped task policy with only runtime relocation'
            } else {
                Assert (([xml]$finalDefinition).OuterXml -ceq ([xml]$prepared.stagedDefinition).OuterXml) `
                    'Unreleased inactive interruption changed staged disabled policy'
            }
        }
        if ($Complete) {
            Assert ([bool](Get-Command Open-AgentsChatInactiveCompletionProof -ErrorAction SilentlyContinue)) `
                'Independent inactive completion proof is unavailable'
            $receipt = Join-Path $control 'task-maintenance/inactive-complete-complete.json'
            $heldReceipt = Join-Path $control 'inactive-complete-held.json'
            Move-Item -LiteralPath $receipt -Destination $heldReceipt
            try {
                $refused = $false
                try {
                    $unexpected = Open-AgentsChatInactiveCompletionProof $control
                    Close-AgentsChatTaskCompletionProof $unexpected
                } catch { $refused = $true }
                Assert $refused 'Independent inactive completion accepted a missing receipt'
            } finally { Move-Item -LiteralPath $heldReceipt -Destination $receipt }
            $foreign = Join-Path $control 'task-maintenance/foreign.json'
            [Deployment.WindowsPrivateFile]::Publish($foreign, '{}').Dispose()
            try {
                $refused = $false
                try {
                    $unexpected = Open-AgentsChatInactiveCompletionProof $control
                    Close-AgentsChatTaskCompletionProof $unexpected
                } catch { $refused = $true }
                Assert $refused 'Independent inactive completion accepted foreign evidence'
            } finally { Remove-Item -LiteralPath $foreign }
            Move-Item -LiteralPath $receipt -Destination $heldReceipt
            try {
                $changed = Get-Content -LiteralPath $heldReceipt -Raw | ConvertFrom-Json
                $changed.previousSha256 = '0' * 64
                [Deployment.WindowsPrivateFile]::Publish($receipt, ($changed | ConvertTo-Json -Depth 8 -Compress)).Dispose()
                $refused = $false
                try {
                    $unexpected = Open-AgentsChatInactiveCompletionProof $control
                    Close-AgentsChatTaskCompletionProof $unexpected
                } catch { $refused = $true }
                Assert $refused 'Independent inactive completion accepted a broken hash chain'
            } finally {
                if (Test-Path -LiteralPath $receipt) { Remove-Item -LiteralPath $receipt }
                Move-Item -LiteralPath $heldReceipt -Destination $receipt
            }
            $proof = Open-AgentsChatInactiveCompletionProof $control
            try {
                $observed = Assert-AgentsChatInactiveCompletionProof $proof
                Assert ($observed.status -ceq 'observed' -and -not $observed.mutationAuthority -and
                    $observed.operationId -ceq $state.operationId -and
                    $observed.runtime.identity -ceq $running.runtime.identity -and
                    $observed.lease -ceq 'released') 'Independent inactive proof changed completion identity'
                $again = Assert-AgentsChatInactiveCompletionProof $proof
                Assert (($observed | ConvertTo-Json -Depth 8 -Compress) -ceq
                    ($again | ConvertTo-Json -Depth 8 -Compress)) 'Independent inactive completion changed on recheck'
                $folder.GetTask($TaskName).Enabled = $true
                $refused = $false
                try { $null = Assert-AgentsChatInactiveCompletionProof $proof } catch { $refused = $true }
                Assert $refused 'Independent inactive completion accepted task policy drift'
            } finally {
                $folder.GetTask($TaskName).Enabled = $false
                Close-AgentsChatTaskCompletionProof $proof
            }
            $proof = Open-AgentsChatInactiveCompletionProof $control
            try { $null = Assert-AgentsChatInactiveCompletionProof $proof }
            finally { Close-AgentsChatTaskCompletionProof $proof }
            Write-Output 'PASS: independent inactive completion retains exact journal, accepted state, released runtime and listener; missing/foreign evidence, broken chains and policy drift are refused'
            $observer = [Deployment.WindowsControllerProcess]::Start($node,
                @((Join-Path $PSScriptRoot 'deployment-windows-completion-session.mjs'), $control,
                    [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, 'inactive'), $control, $environment)
            try {
                $observerOutput = $observer.StandardOutput.ReadToEndAsync()
                $observerDiagnostic = $observer.StandardError.ReadToEndAsync()
                Assert ($observer.WaitForExit(180000)) 'Independent inactive proof Node transport timed out'
                Write-Output $observerOutput.GetAwaiter().GetResult()
                $errors = $observerDiagnostic.GetAwaiter().GetResult()
                if ($errors) { [Console]::Error.WriteLine($errors) }
                Assert ($observer.ExitCode -eq 0) 'Independent inactive proof Node transport failed'
            } finally { $observer.Dispose() }
            $finalDefinition = (Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-replacement-complete.json') -Raw |
                ConvertFrom-Json).definition
            $stateHash = (Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash
            $lockHash = (Get-FileHash -LiteralPath (Join-Path $control 'lock/owner.json') -Algorithm SHA256).Hash
            foreach ($retirementMode in @('inactive-retire-crash', 'inactive-retire-resume')) {
                $retirement = [Deployment.WindowsControllerProcess]::Start($node,
                    @((Join-Path $PSScriptRoot 'deployment-windows-completion-session.mjs'), $control,
                        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $retirementMode), $control, $environment)
                try {
                    $retirementDiagnostic = $retirement.StandardError.ReadToEndAsync()
                    if ($retirementMode -ceq 'inactive-retire-crash') {
                        $line = $retirement.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(120000)) 'Inactive retirement actor did not reach held prefix'
                        $held = $line.GetAwaiter().GetResult() | ConvertFrom-Json
                        Assert ($held.held -and $held.retiredFiles -eq 3) 'Inactive retirement actor reported wrong held prefix'
                        $bridge = [Diagnostics.Process]::GetProcessById($held.bridge.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($held.bridge.pid) -ceq
                                $held.bridge.processIdentity) 'Held inactive retirement bridge changed'
                            $retirement.Kill()
                            Assert ($retirement.WaitForExit(15000) -and $retirement.ExitCode -ne 0) `
                                'Inactive retirement actor did not terminate abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Inactive retirement bridge survived original actor death'
                        } finally { $bridge.Dispose() }
                        $errors = $retirementDiagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        Assert (@(Get-ChildItem -LiteralPath (Join-Path $control 'task-maintenance')).Count -eq 10) `
                            'Abrupt retirement changed its acknowledged receipt prefix'
                        Write-Output 'PASS: abrupt inactive retirement actor death settles its exact native bridge and preserves prefix three'
                        continue
                    }
                    $retirementOutput = $retirement.StandardOutput.ReadToEndAsync()
                    Assert ($retirement.WaitForExit(180000)) 'Independent inactive receipt retirement timed out'
                    Write-Output $retirementOutput.GetAwaiter().GetResult()
                    $errors = $retirementDiagnostic.GetAwaiter().GetResult()
                    if ($errors) { [Console]::Error.WriteLine($errors) }
                    Assert ($retirement.ExitCode -eq 0) 'Independent inactive receipt retirement failed'
                } finally { $retirement.Dispose() }
            }
            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash -ceq $stateHash -and
                (Get-FileHash -LiteralPath (Join-Path $control 'lock/owner.json') -Algorithm SHA256).Hash -ceq $lockHash) `
                'Interrupted inactive retirement changed accepted state or original lock'
            $preservedPaths = @((Join-Path $control 'state.json'), (Join-Path $control 'backup/manifest.json'),
                (Join-Path $control 'backup/complete.json'))
            $preservedHashes = @($preservedPaths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
            foreach ($closeoutMode in @('inactive-deployment-crash', 'inactive-deployment-precommit', 'inactive-deployment-resume')) {
                $closeout = [Deployment.WindowsControllerProcess]::Start($node,
                    @((Join-Path $PSScriptRoot 'deployment-windows-completion-session.mjs'), $control,
                        [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $closeoutMode), $control, $environment)
                try {
                    $closeoutDiagnostic = $closeout.StandardError.ReadToEndAsync()
                    if ($closeoutMode -cne 'inactive-deployment-resume') {
                        $line = $closeout.StandardOutput.ReadLineAsync()
                        Assert ($line.Wait(600000)) 'Inactive deployment actor did not reach held cleanup boundary'
                        $held = $line.GetAwaiter().GetResult() | ConvertFrom-Json
                        $expected = if ($closeoutMode -ceq 'inactive-deployment-crash') { 1 } else { $held.totalEntries }
                        Assert ($held.held -and $held.retiredEntries -eq $expected) 'Inactive deployment actor held wrong prefix'
                        $bridge = [Diagnostics.Process]::GetProcessById($held.bridge.pid)
                        try {
                            $null = $bridge.Handle
                            Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($held.bridge.pid) -ceq
                                $held.bridge.processIdentity) 'Held inactive deployment bridge changed'
                            $closeout.Kill()
                            Assert ($closeout.WaitForExit(15000) -and $closeout.ExitCode -ne 0) 'Inactive deployment actor did not terminate abruptly'
                            Assert ($bridge.WaitForExit(15000)) 'Inactive deployment bridge survived actor death'
                        } finally { $bridge.Dispose() }
                        $errors = $closeoutDiagnostic.GetAwaiter().GetResult()
                        if ($errors) { [Console]::Error.WriteLine($errors) }
                        Assert (Test-Path -LiteralPath (Join-Path $control 'worker-retirement.json')) `
                            'Interrupted inactive deployment lost its original cleanup manifest'
                        Assert ((Test-Path -LiteralPath (Join-Path $control 'lock')) -eq
                            ($closeoutMode -ceq 'inactive-deployment-crash')) 'Interrupted closeout changed its expected lock boundary'
                        Write-Output "PASS: inactive deployment actor death preserves exact cleanup prefix $expected and settles its native bridge"
                        continue
                    }
                    $closeoutOutput = $closeout.StandardOutput.ReadToEndAsync()
                    Assert ($closeout.WaitForExit(600000)) 'Inactive deployment closeout timed out'
                    Write-Output $closeoutOutput.GetAwaiter().GetResult()
                    $errors = $closeoutDiagnostic.GetAwaiter().GetResult()
                    if ($errors) { [Console]::Error.WriteLine($errors) }
                    Assert ($closeout.ExitCode -eq 0) 'Inactive deployment closeout failed'
                } finally { $closeout.Dispose() }
            }
            for ($index = 0; $index -lt $preservedPaths.Count; $index++) {
                Assert ((Get-FileHash -LiteralPath $preservedPaths[$index] -Algorithm SHA256).Hash -ceq $preservedHashes[$index]) `
                    'Interrupted inactive deployment changed accepted state or retained backup'
            }
            $task = $folder.GetTask($TaskName)
            Assert ($state.phase -ceq 'accepted' -and [string]$task.Xml -ceq $finalDefinition -and
                -not $task.Enabled -and $task.GetInstances(0).Count -eq 1 -and
                [string]$task.GetSecurityDescriptor(7) -ceq $security) 'Inactive completion did not retain permanent disabled running policy'
            $runtime = $running.runtime
            $releasedOwner = [Diagnostics.Process]::GetProcessById($runtime.pid)
            try {
                $null = $releasedOwner.Handle
                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -ceq $runtime.identity) 'Released runtime owner changed'
                Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
                    $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') 'Inactive completion did not release its actual lease'
                $settled = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
                    $runtime.pid, $runtime.identity, 'stop', 15000) | ConvertFrom-Json
                Assert ($settled.quiescent -and $settled.members.Count -eq 0) 'Released inactive runtime did not settle its Job'
                Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
                    $runtime.pid, $runtime.identity, 'retire', 15000) -ceq 'retired') 'Released inactive owner did not retire'
                Assert ($releasedOwner.WaitForExit(15000) -and $releasedOwner.ExitCode -eq 0) 'Released inactive owner did not exit cleanly'
            } finally { $releasedOwner.Dispose() }
            Write-Output 'PASS: inactive completion leaves the accepted runtime alive after controller exit with released lease and original permanent disabled policy'
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.ToString())
        throw
    } finally {
        if ($controller) { $controller.Dispose() }
        Remove-Item -LiteralPath $control -Recurse -Force
    }
    $task = $folder.GetTask($TaskName)
    Assert ([string]$task.Xml -ceq $finalDefinition -and
        $running.configuration -ceq (Join-Path $expectedBundle 'configuration.json') -and
        [string]$task.GetSecurityDescriptor(7) -ceq $security -and
        $task.GetInstances(0).Count -eq 0 -and -not $task.Enabled) 'Inactive startup guard did not settle with its exact disabled policy'
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$running.runtime.generation, $running.runtime.sessionId)
    Assert (($copyRecovered -or (Get-Item -LiteralPath $ReadyFile).LastWriteTimeUtc.Ticks -eq $mtime) -and
        (Get-FileHash -LiteralPath $ReadyFile -Algorithm SHA256).Hash -ceq $hash) 'Inactive observation changed original readiness'
    Write-Output 'PASS: native inactive guarded startup preserves original retired readiness and settles its actual new instance with exact disabled policy'
}
