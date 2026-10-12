param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot', 'PATH')) { $environment.Add($name, [Environment]::GetEnvironmentVariable($name)) }
$environment.Add('TEMP', $Control)
$environment.Add('TMP', $Control)
$terminal = Get-Content -LiteralPath (Join-Path $Control 'cold-restore-terminal.json') -Raw | ConvertFrom-Json
$originals = @{}
foreach ($name in @('state.json', 'cold-restore-terminal.json', 'lock/owner.json',
    'task-maintenance/transaction.json', 'backup/manifest.json')) {
    $file = Join-Path $Control $name
    $originals[$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Control 'recovery-lock') -File)) {
    $originals[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
$transactionPath = Join-Path $Control 'task-maintenance/transaction.json'
$transaction = [Deployment.WindowsPrivateFile]::Open($transactionPath, $originals[$transactionPath].ToLowerInvariant())
try { $transactionIdentity = $transaction.CaptureIdentity() } finally { $transaction.Dispose() }
$stageIdentity = $receiptHash = $null
foreach ($target in @('receipt-staged', 'receipt-published', 'complete', 'complete')) {
    $actor = $bridge = $diagnostic = $null
    try {
        $actor = [Deployment.WindowsControllerProcess]::Start((Get-Command node).Source, [string[]]@(
            (Join-Path $PSScriptRoot 'deployment-windows-cold-receipt.mjs'), $Control,
            [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $target), $Control, $environment)
        $diagnostic = $actor.StandardError.ReadToEndAsync()
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($actor.StandardOutput, 131072)
        if (-not $frame.Wait(300000)) { throw "Cold receipt actor did not reach $target." }
        $result = $frame.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($target -cne 'complete') {
            if ($result.progress.step -cne $target) { throw 'Cold receipt actor skipped its interruption boundary.' }
            $bridge = [Diagnostics.Process]::GetProcessById($result.progress.identity.pid)
            $null = $bridge.Handle
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id) -cne $result.progress.identity.processIdentity) {
                throw 'Cold receipt actor lost its exact native bridge.'
            }
            if ($target -ceq 'receipt-staged') {
                $stage = Join-Path $Control '.deployment.json.staging'
                $receiptHash = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant()
                $staged = [Deployment.WindowsPrivateFile]::Open($stage, $receiptHash)
                try { $stageIdentity = $staged.CaptureIdentity() } finally { $staged.Dispose() }
            } else {
                $bridge.Kill()
                if (-not $bridge.WaitForExit(15000)) { throw 'Cold receipt bridge survived termination.' }
            }
            $actor.Kill()
            if (-not $actor.WaitForExit(15000) -or -not $bridge.WaitForExit(15000)) {
                throw 'Cold receipt controllers survived interruption.'
            }
        } elseif (-not $actor.WaitForExit(15000) -or $actor.ExitCode -ne 0) {
            throw 'Cold receipt reentry did not close cleanly.'
        }
        if ($target -cne 'receipt-staged') {
            $receipt = [Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'deployment.json'), $receiptHash)
            try {
                $identity = $receipt.CaptureIdentity()
                if ($identity.Dev -cne $stageIdentity.Dev -or $identity.Ino -cne $stageIdentity.Ino) {
                    throw 'Cold receipt replaced the original staged inode on publication or reentry.'
                }
            } finally { $receipt.Dispose() }
        }
        foreach ($file in @($originals.Keys)) {
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $originals[$file]) {
                throw 'Cold receipt publication changed original terminal state, lock or journal.'
            }
        }
        $transaction = [Deployment.WindowsPrivateFile]::Open($transactionPath, $originals[$transactionPath].ToLowerInvariant())
        try {
            $identity = $transaction.CaptureIdentity()
            if ($identity.Dev -cne $transactionIdentity.Dev -or $identity.Ino -cne $transactionIdentity.Ino) {
                throw 'Cold receipt publication replaced the original transaction inode.'
            }
        } finally { $transaction.Dispose() }
        $runtime = $terminal.runtime
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($runtime.pid) -cne $runtime.identity -or
            [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'released') {
            throw 'Cold receipt publication restarted or lost the original released runtime.'
        }
    } finally {
        if ($actor -and -not $actor.HasExited) {
            $actor.Kill()
            if (-not $actor.WaitForExit(15000)) { throw 'Cold receipt actor cleanup failed.' }
        }
        if ($bridge -and -not $bridge.HasExited -and -not $bridge.WaitForExit(15000)) {
            throw 'Cold receipt bridge cleanup failed.' }
        if ($diagnostic) {
            $text = $diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        }
        foreach ($process in @($bridge, $actor)) { if ($process) { $process.Dispose() } }
    }
}
Write-Output 'PASS: cold receipt survives staged and published interruptions, retains its staged inode and rejects forged, closed or wrong-scope authority'
