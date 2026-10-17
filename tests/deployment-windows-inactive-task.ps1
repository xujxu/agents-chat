function Test-AgentsChatInactiveTask([string]$Source, [string]$TaskName, [string]$Project, [string]$ReadyFile,
    [switch]$Complete, [switch]$Recover,
    [ValidateSet('lease-released', 'released', 'policy-restore-requested', 'permanent-policy-applied')]
    [string]$RecoveryStep = 'lease-released') {
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
            $bridge = [Diagnostics.Process]::GetProcessById($held.bridge.pid)
            try {
                $null = $bridge.Handle
                Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($held.bridge.pid) -ceq
                    $held.bridge.identity) 'Inactive completion bridge identity changed'
                $controller.Kill()
                Assert ($controller.WaitForExit(15000) -and $controller.ExitCode -ne 0) `
                    'Inactive completion actor did not die abruptly'
                Assert ($bridge.WaitForExit(15000)) 'Inactive completion bridge survived actor death'
            } finally { $bridge.Dispose() }
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
        if ($Recover) {
            Assert ([bool](Get-Command Open-AgentsChatInactiveCompletionRecovery -ErrorAction SilentlyContinue)) `
                'Missing inactive released-prefix completion recovery'
            $refused = $false
            try {
                $unexpected = Open-AgentsChatInactiveCompletionProof $control
                Close-AgentsChatTaskCompletionProof $unexpected
            } catch { $refused = $true }
            Assert $refused 'Complete inactive proof accepted an interrupted prefix'
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
                foreach ($step in $steps[($index + 1)..4]) {
                    $observed = Advance-AgentsChatInactiveCompletionRecovery $recovery
                    Assert ($observed.step -ceq $step) 'Inactive recovery acknowledged an unexpected phase'
                    if ($step -ceq 'released') {
                        Close-AgentsChatTaskCompletionProof $recovery
                        $recovery = Open-AgentsChatInactiveCompletionRecovery $control
                        $observed = Assert-AgentsChatInactiveCompletionRecovery $recovery
                        Assert ($observed.phase -ceq 'released') 'Reopened inactive recovery lost its durable prefix'
                    }
                }
                Assert ($observed.status -ceq 'complete') 'Inactive recovery did not complete'
            } finally { Close-AgentsChatTaskCompletionProof $recovery }
            Assert ((Get-FileHash -LiteralPath (Join-Path $control 'state.json')).Hash -ceq $stateBefore) `
                'Inactive recovery changed accepted state'
            Write-Output "PASS: inactive released-prefix recovery at $RecoveryStep survives original actor death, refuses concurrent takeover and retains its real durable prefix"
        }
        $state = Get-Content -LiteralPath (Join-Path $control 'state.json') -Raw | ConvertFrom-Json
        $expectedBundle = Join-Path $control "runtime-$($state.operationId)"
        $running = Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-start-running.json') -Raw |
            ConvertFrom-Json
        $finalDefinition = $running.definition
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
    Assert ((Get-Item -LiteralPath $ReadyFile).LastWriteTimeUtc.Ticks -eq $mtime -and
        (Get-FileHash -LiteralPath $ReadyFile -Algorithm SHA256).Hash -ceq $hash) 'Inactive observation changed original readiness'
    Write-Output 'PASS: native inactive guarded startup preserves original retired readiness and settles its actual new instance with exact disabled policy'
}
