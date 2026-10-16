function Test-AgentsChatInactiveTask([string]$Source, [string]$TaskName, [string]$Project, [string]$ReadyFile,
    [switch]$Complete) {
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
                $(if ($Complete) { 'complete' } else { 'guarded' })), $control, $environment)
        $output = $controller.StandardOutput.ReadToEndAsync()
        $diagnostic = $controller.StandardError.ReadToEndAsync()
        Assert ($controller.WaitForExit(600000)) 'Inactive task Node bridge timed out'
        Write-Output $output.GetAwaiter().GetResult()
        $errors = $diagnostic.GetAwaiter().GetResult()
        if ($errors) { [Console]::Error.WriteLine($errors) }
        Assert ($controller.ExitCode -eq 0) 'Inactive task Node bridge failed'
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
            $finalDefinition = (Get-Content -LiteralPath (Join-Path $control 'task-maintenance/inactive-replacement-complete.json') -Raw |
                ConvertFrom-Json).definition
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
