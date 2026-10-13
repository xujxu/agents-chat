param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot', 'PATH')) { $environment.Add($name, [Environment]::GetEnvironmentVariable($name)) }
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$terminal = Get-Content -LiteralPath (Join-Path $Control 'cold-restore-terminal.json') -Raw | ConvertFrom-Json
$originals = @{}
foreach ($name in @('state.json', 'deployment.json', 'backup/manifest.json')) {
    $file = Join-Path $Control $name
    $originals[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
$manifestIdentity = $manifestHash = $null
foreach ($target in @('prepared', 'refusals', 'early', 'unlock', 'complete')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot 'deployment-windows-cold-retirement.mjs'), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
        if (-not $frame.Wait(900000)) { throw "Cold retirement actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($target -cin @('prepared', 'early', 'unlock')) {
            $expected = if ($target -ceq 'prepared') { 0 } elseif ($target -ceq 'early') { 2 } else { $result.progress.totalEntries - 2 }
            if ($result.progress.retiredEntries -ne $expected) { throw 'Cold retirement skipped its interruption boundary.' }
            $bridge = [Diagnostics.Process]::GetProcessById($result.progress.identity.pid)
            $null = $bridge.Handle
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $result.progress.identity.processIdentity) {
                throw 'Cold retirement actor lost its exact native bridge.'
            }
            if ($target -ceq 'early') {
                $bridge.Kill()
                if (-not $bridge.WaitForExit(15000)) { throw 'Cold retirement bridge survived termination.' }
            }
            $actor.Kill()
            if (-not $actor.WaitForExit(15000) -or -not $bridge.WaitForExit(15000)) {
                throw 'Cold retirement controllers survived interruption.'
            }
        } elseif (-not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
            throw 'Cold retirement refusal or completed-closeout actor failed.'
        }
        $markerPath = Join-Path $Control 'worker-retirement.json'
        if ($target -cne 'complete') {
            $hash = (Get-FileHash -LiteralPath $markerPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $marker = [Deployment.WindowsPrivateFile]::Open($markerPath, $hash)
            try {
                $identity = $marker.CaptureIdentity()
                if ($manifestHash) {
                    if ($hash -cne $manifestHash -or $identity.Dev -cne $manifestIdentity.Dev -or $identity.Ino -cne $manifestIdentity.Ino) {
                        throw 'Cold retirement reentry replaced its original immutable manifest.'
                    }
                } else { $manifestHash = $hash; $manifestIdentity = $identity }
            } finally { $marker.Dispose() }
            if (-not (Test-Path -LiteralPath (Join-Path $Control 'lock\owner.json'))) {
                throw 'Cold retirement released the original owner before its acknowledged final boundary.'
            }
        } elseif (Test-Path -LiteralPath $markerPath) { throw 'Completed cold retirement retained its manifest.' }
        foreach ($file in @($originals.Keys)) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold retirement changed accepted state, receipt or backup.'
            }
        }
        $runtime = $terminal.runtime
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity -or
            [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'released') {
            throw 'Cold retirement restarted or lost the original released runtime.'
        }
    } finally {
        if ($actor -and -not $actor.HasExited) {
            $actor.Kill()
            if (-not $actor.WaitForExit(15000)) { throw 'Cold retirement actor cleanup failed.' }
        }
        if ($bridge -and -not $bridge.HasExited -and -not $bridge.WaitForExit(15000)) {
            throw 'Cold retirement bridge cleanup failed.'
        }
        if ($diagnostic) {
            $text = $diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        }
        foreach ($process in @($bridge, $actor)) { if ($process) { $process.Dispose() } }
    }
}
Write-Output 'PASS: cold retirement resumes three interruption boundaries, refuses foreign/replaced/non-prefix evidence and retains the original released runtime'
