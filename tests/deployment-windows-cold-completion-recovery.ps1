param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot', 'PATH')) { $environment.Add($name, [Environment]::GetEnvironmentVariable($name)) }
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$originals = @{}
foreach ($name in @('state.json', 'lock/owner.json', 'task-maintenance/transaction.json', 'backup/manifest.json')) {
    $file = Join-Path $Control $name
    $originals[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
$running = $runtime = $null
foreach ($target in @('lease-released', 'permanent-policy-applied', 'enable-applied', 'complete')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $script = if ($target -ceq 'lease-released') {
            'deployment-windows-cold-runtime-completion.mjs'
        } else { 'deployment-windows-cold-completion-recovery.mjs' }
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot $script), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
        $timeout = if ($target -ceq 'lease-released') { 600000 } else { 180000 }
        if (-not $frame.Wait($timeout)) { throw "Cold completion actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($result.progress.step -cne $target) { throw 'Cold completion actor skipped its physical interruption boundary.' }
        if ($target -ceq 'lease-released') {
            $running = $result.running
            $runtime = $running.runtime
        }
        if ($target -cne 'complete') {
            $bridge = [Diagnostics.Process]::GetProcessById($result.identity.pid)
            $null = $bridge.Handle
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $result.identity.processIdentity) {
                throw 'Cold completion recovery lost its exact native bridge.'
            }
            $missing = switch ($target) {
                'lease-released' { 'released' }
                'permanent-policy-applied' { 'policy-restored' }
                'enable-applied' { 'complete' }
            }
            if (Test-Path -LiteralPath (Join-Path $Control "recovery-lock/completion-$missing.json")) {
                throw 'Physical interruption already has its durable acknowledgement.'
            }
            if ($target -ceq 'lease-released') {
                $bridge.Kill()
                if (-not $bridge.WaitForExit(15000)) { throw 'Original completion bridge survived termination.' }
            }
            $actor.Kill()
            if (-not $actor.WaitForExit(15000) -or -not $bridge.WaitForExit(15000)) {
                throw 'Cold completion controllers survived interruption.'
            }
        } elseif (-not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
            throw 'Recovered cold completion actor did not close cleanly.'
        }
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity -or
            [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'released') {
            throw 'Completion takeover restarted or lost its original released runtime.'
        }
        foreach ($file in @($originals.Keys)) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold completion recovery changed original transaction or acknowledged prefix bytes.'
            }
        }
        foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Control 'recovery-lock') -File)) {
            $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        }
    } finally {
        if ($actor -and -not $actor.HasExited) {
            $actor.Kill()
            if (-not $actor.WaitForExit(15000)) { throw 'Cold completion actor cleanup failed.' }
        }
        if ($bridge -and -not $bridge.HasExited -and -not $bridge.WaitForExit(15000)) {
            throw 'Cold completion bridge cleanup failed.'
        }
        if ($diagnostic) {
            $text = $diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        }
        foreach ($process in @($bridge, $actor)) { if ($process) { $process.Dispose() } }
    }
}
$file = Join-Path $Control 'recovery-lock/completion-complete.json'
$completed = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
Write-Output (@{
    running=$running; completed=@{
        status='runtime-policy-restored'; step='complete'; lease='released'; runtime=$runtime
        completionSha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        taskName=$completed.taskName; configuration=$completed.configuration
        definition=$completed.definition; enabled=$completed.enabled; port=$completed.port; providers=$completed.providers
    }
} | ConvertTo-Json -Depth 6 -Compress)
