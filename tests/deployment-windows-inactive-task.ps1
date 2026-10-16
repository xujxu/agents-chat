function Test-AgentsChatInactiveTask([string]$Source, [string]$TaskName, [string]$Project, [string]$ReadyFile) {
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
                [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $control, $git, $npmCli), $control, $environment)
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
    } finally {
        if ($controller) { $controller.Dispose() }
        Remove-Item -LiteralPath $control -Recurse -Force
    }
    $task = $folder.GetTask($TaskName)
    Assert ([string]$task.Xml -ceq $running.definition -and
        $running.configuration -ceq (Join-Path $expectedBundle 'configuration.json') -and
        [string]$task.GetSecurityDescriptor(7) -ceq $security -and
        $task.GetInstances(0).Count -eq 0 -and -not $task.Enabled) 'Inactive startup guard did not settle with its exact disabled policy'
    [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$running.runtime.generation, $running.runtime.sessionId)
    Assert ((Get-Item -LiteralPath $ReadyFile).LastWriteTimeUtc.Ticks -eq $mtime -and
        (Get-FileHash -LiteralPath $ReadyFile -Algorithm SHA256).Hash -ceq $hash) 'Inactive observation changed original readiness'
    Write-Output 'PASS: native inactive guarded startup preserves original retired readiness and settles its actual new instance with exact disabled policy'
}
