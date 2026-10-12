param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$journal = Join-Path $Control 'recovery-lock'
$originals = @{}
foreach ($name in @('state.json', 'lock/owner.json', 'backup/manifest.json')) {
    $originals[(Join-Path $Control $name)] = (Get-FileHash -LiteralPath (Join-Path $Control $name) -Algorithm SHA256).Hash
}
foreach ($file in @(Get-ChildItem -LiteralPath $journal -File)) {
    $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
$originalTask = Get-Content -LiteralPath (Join-Path $Control 'task-maintenance/task-stop-stopped.json') -Raw | ConvertFrom-Json
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('PATH', $env:PATH)
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$appliedIdentity = $null
$sequence = 0
foreach ($target in @('requested', 'policy-applied', 'restored', 'inspect')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot 'deployment-windows-cold-policy-recovery.mjs'), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 16384)
        if (-not $frame.Wait(180000)) { throw "Cold policy actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        $expected = if ($target -ceq 'inspect') { 'restored' } else { $target }
        if ($result.progress.step -cne $expected) { throw 'Cold policy actor skipped its intended boundary.' }
        if ($target -cin @('requested', 'policy-applied')) {
            $bridge = [Diagnostics.Process]::GetProcessById($result.owner.bridgePid)
            $null = $bridge.Handle
            if ($result.owner.controllerPid -ne $actor.Id -or
                [Deployment.WindowsWorkerJob]::ProcessIdentity($actor.Id) -cne $result.owner.controllerIdentity -or
                [Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $result.owner.bridgeIdentity) {
                throw 'Cold policy crash lost its original claimed controller or bridge.'
            }
            $actor.Kill()
            if (-not $actor.WaitForExit(15000) -or -not $bridge.WaitForExit(15000)) {
                throw 'Original claimed policy controller or bridge survived interruption.'
            }
        } elseif ($result.status -cne 'closed' -or -not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
            throw 'Cold policy recovery actor did not close cleanly.'
        }
        $expectedSequence = switch ($target) {
            'requested' { 2 }
            'policy-applied' { 3 }
            default { 5 }
        }
        if ($result.progress.policySequence -ne $expectedSequence) {
            throw 'Cold policy recovery did not preserve each distinct takeover claim.'
        }
        foreach ($file in @($originals.Keys)) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold policy recovery changed its original state, lock, snapshot or journal prefix.'
            }
        }
        $records = @(Get-ChildItem -LiteralPath $journal -Filter 'policy-*.json' -File | Sort-Object Name)
        if ($records.Count -ne $expectedSequence) { throw 'Cold policy journal contains missing or extra records.' }
        foreach ($file in $records) {
            $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        if ($task.Enabled -or $task.GetInstances(0).Count -ne 0 -or
            [string]$task.GetSecurityDescriptor(7) -cne $originalTask.securityDescriptor) {
            throw 'Cold policy recovery enabled a task, started an instance or changed security.'
        }
        if ($target -cne 'requested') {
            if (([xml]$task.Xml).OuterXml -cne ([xml]$originalTask.definition).OuterXml) {
                throw 'Cold policy recovery did not restore the exact original disabled task.'
            }
            $taskFile = Join-Path ([Environment]::SystemDirectory) "Tasks\$TaskName"
            $hash = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
            $held = [Deployment.WindowsPrivateFile]::OpenSourceFile($taskFile, $hash)
            try { $identity = $held.CaptureIdentity() } finally { $held.Dispose() }
            if ($target -ceq 'policy-applied') { $appliedIdentity = $identity }
            elseif ($identity.Dev -cne $appliedIdentity.Dev -or $identity.Ino -cne $appliedIdentity.Ino) {
                throw 'Resumed policy recovery registered an already-applied task again.'
            }
        }
        $sequence = $expectedSequence
    } finally {
        if ($actor -and -not $actor.HasExited) {
            $actor.Kill()
            if (-not $actor.WaitForExit(15000)) { throw 'Cold policy test actor cleanup failed.' }
        }
        if ($bridge -and -not $bridge.HasExited -and -not $bridge.WaitForExit(15000)) {
            throw 'Cold policy test bridge cleanup failed.'
        }
        if ($diagnostic) {
            $text = $diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        }
        foreach ($process in @($bridge, $actor)) { if ($process) { $process.Dispose() } }
    }
}
if ($sequence -ne 5) { throw 'Cold policy recovery did not complete its retained journal.' }
Write-Output 'PASS: cold policy recovery survives request and unacknowledged registration crashes with distinct claimed owners, unchanged evidence and no task restart'
