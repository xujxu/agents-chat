param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot', 'PATH')) { $environment.Add($name, [Environment]::GetEnvironmentVariable($name)) }
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$terminal = Get-Content -LiteralPath (Join-Path $Control 'cold-restore-terminal.json') -Raw | ConvertFrom-Json
$originals = @{}
foreach ($name in @('cold-restore-terminal.json', 'lock/owner.json', 'task-maintenance/transaction.json', 'backup/manifest.json')) {
    $file = Join-Path $Control $name
    $originals[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Control 'recovery-lock') -File)) {
    $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
$stageIdentity = $null
$nextHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($terminal.nextState))).ToLowerInvariant()
foreach ($target in @('state-staged', 'state-published', 'complete', 'complete')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot 'deployment-windows-cold-terminal-state.mjs'), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
        if (-not $frame.Wait(180000)) { throw "Cold terminal state actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($target -cne 'complete') {
            if ($result.progress.step -cne $target) { throw 'Cold terminal state actor skipped its interruption boundary.' }
            $bridge = [Diagnostics.Process]::GetProcessById($result.progress.identity.pid)
            $null = $bridge.Handle
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $result.progress.identity.processIdentity) {
                throw 'Cold terminal state actor lost its exact native bridge.'
            }
            if ($target -ceq 'state-staged') {
                $staged = [Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'state.json.lock'), $nextHash)
                try { $stageIdentity = $staged.CaptureIdentity() } finally { $staged.Dispose() }
            } else {
                $bridge.Kill()
                if (-not $bridge.WaitForExit(15000)) { throw 'Cold terminal publication bridge survived termination.' }
            }
            $actor.Kill()
            if (-not $actor.WaitForExit(15000) -or -not $bridge.WaitForExit(15000)) {
                throw 'Cold terminal state controllers survived interruption.'
            }
        } elseif (-not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
            throw 'Cold terminal state reentry did not close cleanly.'
        }
        $stateHash = if ($target -ceq 'state-staged') { $terminal.stateSha256 } else { $nextHash }
        $state = [Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'state.json'), $stateHash)
        try {
            $identity = $state.CaptureIdentity()
            if ($target -cne 'state-staged' -and
                ($identity.Dev -cne $stageIdentity.Dev -or $identity.Ino -cne $stageIdentity.Ino)) {
                throw 'Cold terminal state was not atomically published from the original staged inode.'
            }
        } finally { $state.Dispose() }
        foreach ($file in @($originals.Keys)) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold terminal state publication changed original handoff, lock or journal.'
            }
        }
        $runtime = $terminal.runtime
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity -or
            [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'released') {
            throw 'Cold terminal state publication restarted or lost the original released runtime.'
        }
    } finally {
        if ($actor -and -not $actor.HasExited) {
            $actor.Kill()
            if (-not $actor.WaitForExit(15000)) { throw 'Cold terminal state actor cleanup failed.' }
        }
        if ($bridge -and -not $bridge.HasExited -and -not $bridge.WaitForExit(15000)) {
            throw 'Cold terminal state bridge cleanup failed.'
        }
        if ($diagnostic) {
            $text = $diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        }
        foreach ($process in @($bridge, $actor)) { if ($process) { $process.Dispose() } }
    }
}
Write-Output 'PASS: cold terminal state survives staged and published controller interruptions with original staged inode and released runtime'
