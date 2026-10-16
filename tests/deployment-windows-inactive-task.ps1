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
        $controller = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source,
            @((Join-Path $PSScriptRoot 'deployment-windows-inactive-task.mjs'), $Source, $TaskName, $Project,
                [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $control), $control, $environment)
        $output = $controller.StandardOutput.ReadToEndAsync()
        $diagnostic = $controller.StandardError.ReadToEndAsync()
        Assert ($controller.WaitForExit(300000)) 'Inactive task Node bridge timed out'
        Write-Output $output.GetAwaiter().GetResult()
        $errors = $diagnostic.GetAwaiter().GetResult()
        if ($errors) { [Console]::Error.WriteLine($errors) }
        Assert ($controller.ExitCode -eq 0) 'Inactive task Node bridge failed'
    } finally {
        if ($controller) { $controller.Dispose() }
        Remove-Item -LiteralPath $control -Recurse -Force
    }
    $task = $folder.GetTask($TaskName)
    Assert ([string]$task.Xml -ceq $definition -and [string]$task.GetSecurityDescriptor(7) -ceq $security -and
        $task.GetInstances(0).Count -eq 0 -and -not $task.Enabled) 'Inactive observation changed task policy or started work'
    Assert ((Get-Item -LiteralPath $ReadyFile).LastWriteTimeUtc.Ticks -eq $mtime -and
        (Get-FileHash -LiteralPath $ReadyFile -Algorithm SHA256).Hash -ceq $hash) 'Inactive observation changed original readiness'
    Write-Output 'PASS: native inactive task observation retains disabled policy and retired readiness, rejects changed policy and invents no runtime'
}
