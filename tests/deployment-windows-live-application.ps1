param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$ChatId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helpers = Join-Path $repository 'scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs', 'WindowsControllerCapture.cs' | ForEach-Object { Join-Path $helpers $_ })
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$git = (Get-Command git).Source
$npm = Join-Path (Split-Path $Node) 'node_modules/npm/bin/npm-cli.js'
$control = Join-Path $Root 'live-control'
$directory = Join-Path $Root 'captured-controller'
$capture = $null
$actor = $null
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
try {
    [Deployment.WindowsPrivateFile]::CreateDirectory($control).Dispose()
    $capture = [Deployment.WindowsControllerCapture]::Create($repository, $Project, $directory)
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('TEMP', $Root)
    $environment.Add('TMP', $Root)
    foreach ($mode in @('update', 'finalize', 'current')) {
        $elapsed = [Diagnostics.Stopwatch]::StartNew()
        $capture.Check()
        $before = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        Assert ($before.Count -eq 1) 'Live application must have one original task instance'
        $originalPid = $before.Item(1).EnginePID
        $originalInstance = $before.Item(1).InstanceGuid
        $actor = [Deployment.WindowsControllerProcess]::Start($Node,
            @((Join-Path $PSScriptRoot 'deployment-windows-live-application.mjs'),
                $mode, $directory, $Project, $control, $TaskName, $pwsh, $git, $npm), $directory, $environment)
        $output = $actor.StandardOutput.ReadToEndAsync()
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $actorTimeout = if ($mode -eq 'update') { 1200000 } else { 300000 }
        $exited = $actor.WaitForExit($actorTimeout)
        $actor.Kill()
        Assert ($actor.WaitForExit(15000)) 'Live application controller did not settle after Job termination'
        $code = $actor.ExitCode
        Assert ($output.Wait(15000) -and $diagnostic.Wait(15000)) 'Live controller streams did not settle'
        [Console]::Error.Write($diagnostic.GetAwaiter().GetResult())
        $text = $output.GetAwaiter().GetResult()
        Assert $exited "Live application controller $mode exceeded its bound; output: $text"
        Assert ($code -eq 0) "Live controller $mode failed: $text"
        $result = $text | ConvertFrom-Json
        $expected = switch ($mode) { update { 'accepted' } finalize { 'completed' } current { 'already-current' } }
        Assert ($result.status -ceq $expected) "Unexpected live controller $mode status"
        $actor.Dispose()
        $actor = $null
        $capture.Check()
        $after = $scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0)
        Assert ($after.Count -eq 1) 'Live deployment lost the application task'
        if ($mode -eq 'update') {
            Assert ($after.Item(1).EnginePID -ne $originalPid -and $after.Item(1).InstanceGuid -cne $originalInstance) `
                'Live deployment did not activate a new original runtime'
        } else {
            Assert ($after.Item(1).EnginePID -eq $originalPid -and $after.Item(1).InstanceGuid -ceq $originalInstance) `
                'Closeout or already-current restarted the accepted application'
            & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') restored $ChatId
            Assert ($LASTEXITCODE -eq 0) "Authenticated data was lost during $mode"
        }
        Write-Output "PASS: real Windows live deployment $mode with captured controller and preserved task/data; elapsedMs=$($elapsed.ElapsedMilliseconds)"
    }
} finally {
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
