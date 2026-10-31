param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [switch]$Preparation,
    [switch]$Unlaunched
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Preparation -and $Unlaunched) { throw 'Preparation and enable-intent evidence are mutually exclusive.' }
$journal = Join-Path $Control 'recovery-lock'
$originals = @{}
foreach ($name in @('state.json', 'lock/owner.json', 'backup/manifest.json')) {
    $originals[(Join-Path $Control $name)] = (Get-FileHash -LiteralPath (Join-Path $Control $name) -Algorithm SHA256).Hash
}
foreach ($file in @(Get-ChildItem -LiteralPath $journal -File)) {
    $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
if (-not (Test-Path -LiteralPath (Join-Path $journal 'activation-running.json'))) {
    $intent = Get-Content -LiteralPath (Join-Path $journal 'activation-intent.json') -Raw | ConvertFrom-Json
    $launches = @(Get-ChildItem -LiteralPath $intent.runtimeBundle.directory -Filter 'launch-*.json' -File)
    if ($Preparation -or $Unlaunched) {
        $request = Get-Content -LiteralPath (Join-Path $journal 'activation-start-requested.json') -Raw | ConvertFrom-Json
        $enableFile = Join-Path $intent.runtimeBundle.directory 'enable-requested.json'
        if ($request.version -ne 2 -or $launches.Count -ne 0 -or
            [bool](Test-Path -LiteralPath $enableFile) -ne [bool]$Unlaunched) {
            throw 'Unlaunched policy fixture lacks its original preparation or enable evidence.'
        }
        if ($Unlaunched) {
            $originals[$enableFile] = (Get-FileHash -LiteralPath $enableFile -Algorithm SHA256).Hash
        }
    } else {
        if ($launches.Count -ne 1) { throw 'Unacknowledged policy fixture lost its unique original launch.' }
        $originals[$launches[0].FullName] = (Get-FileHash -LiteralPath $launches[0].FullName -Algorithm SHA256).Hash
    }
}
$originalTask = Get-Content -LiteralPath (Join-Path $Control 'task-maintenance/task-stop-stopped.json') -Raw | ConvertFrom-Json
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$sourceTask = $scheduler.GetFolder('\').GetTask($TaskName)
$sourceEnabled = [bool]$sourceTask.Enabled
$sourceDefinition = [string]$sourceTask.Xml
$appliedIdentity = $null
$sequence = 0
foreach ($target in @('requested', 'policy-applied', 'restored', 'inspect', 'archive')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot 'deployment-windows-cold-policy-recovery.mjs'), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 16384)
        if (-not $frame.Wait(180000)) { throw "Cold policy actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        $expected = if ($target -cin @('inspect', 'archive')) { 'restored' } else { $target }
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
        } else {
            $status = if ($target -ceq 'archive') { 'archived-and-copied' } else { 'closed' }
            if ($result.status -cne $status -or -not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
                throw 'Cold policy recovery actor did not close cleanly.'
            }
        }
        $expectedSequence = switch ($target) {
            'requested' { 2 }
            'policy-applied' { 3 }
            'archive' { 6 }
            default { 5 }
        }
        if ($result.progress.policySequence -ne $expectedSequence) {
            throw 'Cold policy recovery did not preserve each distinct takeover claim.'
        }
        foreach ($file in @($originals.Keys)) {
            $current = if ($target -ceq 'archive' -and $file.StartsWith("$journal\", [StringComparison]::OrdinalIgnoreCase)) {
                Join-Path $result.archived.archive $file.Substring($journal.Length + 1)
            } else { $file }
            if ((Get-FileHash -LiteralPath $current -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold policy recovery changed its original state, lock, snapshot or journal prefix.'
            }
        }
        $retained = if ($target -ceq 'archive') { $result.archived.archive } else { $journal }
        $records = @(Get-ChildItem -LiteralPath $retained -Filter 'policy-*.json' -File | Sort-Object Name)
        if ($records.Count -ne $expectedSequence) { throw 'Cold policy journal contains missing or extra records.' }
        foreach ($file in $records) {
            $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
        if ($target -ceq 'archive') {
            $archive = [Deployment.WindowsPrivateFile]::OpenDirectory($result.archived.archive)
            $fresh = $null
            try {
                $fresh = [Deployment.WindowsPrivateFile]::OpenDirectory($journal)
                $oldIdentity = $archive.CaptureIdentity()
                $newIdentity = $fresh.CaptureIdentity()
                if ($oldIdentity.Dev -cne $result.archived.identity.dev -or
                    $oldIdentity.Ino -cne $result.archived.identity.ino -or
                    ($newIdentity.Dev -ceq $oldIdentity.Dev -and $newIdentity.Ino -ceq $oldIdentity.Ino)) {
                    throw 'Fresh cold claim reused or replaced the archived original journal.'
                }
            } finally {
                if ($fresh) { $fresh.Dispose() }
                $archive.Dispose()
            }
            $names = @(Get-ChildItem -LiteralPath $journal -Force | ForEach-Object Name | Sort-Object)
            $owner = Get-Content -LiteralPath (Join-Path $journal 'owner.json') -Raw | ConvertFrom-Json
            if (($names -join ',') -cne 'files-restored.json,owner.json' -or
                $owner.owner.operationId -cne $result.ownerId -or
                $result.runtimeBundle -cne (Join-Path $Control "runtime-$($result.ownerId)")) {
                throw 'Archived cold policy did not admit a fresh original-policy claim and completed copy.'
            }
        }
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        if (($Preparation -or $Unlaunched) -and @(Get-ChildItem -LiteralPath $intent.runtimeBundle.directory -Force |
            Where-Object { $_.Name -imatch '^(launch|runtime)-.*\.json$' -or
                ($Preparation -and $_.Name -ieq 'enable-requested.json') }).Count -ne 0) {
            throw 'Unlaunched policy takeover manufactured enable or runtime evidence.'
        }
        $expectedEnabled = $target -ceq 'requested' -and $sourceEnabled
        if ([bool]$task.Enabled -ne $expectedEnabled -or $task.GetInstances(0).Count -ne 0 -or
            [string]$task.GetSecurityDescriptor(7) -cne $originalTask.securityDescriptor) {
            throw 'Cold policy recovery changed enabled state before its write-ahead request, started an instance or changed security.'
        }
        if ($target -ceq 'requested' -and [string]$task.Xml -cne $sourceDefinition) {
            throw 'Cold policy request mutated its original guarded source before policy application.'
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
if ($sequence -ne 6) { throw 'Cold policy recovery did not complete its retained journal and archival claim.' }
Write-Output 'PASS: cold policy recovery survives repeated crashes, archives its exact original journal and admits a fresh complete cold copy without task restart'
