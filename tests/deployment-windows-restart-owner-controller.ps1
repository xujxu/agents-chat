function Send-AgentsChatRestartOwnerCommand($Process, $Diagnostic, $Live, [string]$Control) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $line = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
        Assert ($line.Wait([int]$remaining)) 'Live restart directory stage timed out before owner command'
        $text = $line.GetAwaiter().GetResult()
        if ($null -eq $text) {
            Assert ($Process.WaitForExit(15000)) 'Live restart directory publisher closed output without exiting'
            [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
            throw 'Live restart directory publisher exited before owner checkpoint'
        }
        if ($text.StartsWith('INACTIVE_HISTORY_RESTART_DIRECTORY_LIVE ')) { break }
        [Console]::Out.WriteLine($text)
        Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart directory stage exceeded budget'
    }
    $directory = $text.Substring('INACTIVE_HISTORY_RESTART_DIRECTORY_LIVE '.Length) | ConvertFrom-Json
    Assert ($directory.actorPid -eq $Process.Id -and $directory.actorIdentity -ceq $Live.actorIdentity -and
        $directory.pid -eq $Live.pid -and $directory.processIdentity -ceq $Live.processIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($directory.actorPid) -ceq $directory.actorIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($directory.pid) -ceq $directory.processIdentity) `
        'Restart owner checkpoint changed its actual live publisher or bridge'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        Assert ($directory.prepared.$field -ceq $Live.prepared.$field) 'Restart owner checkpoint changed its preparation'
    }
    Assert ((Get-FileHash -LiteralPath (Join-Path $Control $directory.prepared.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $directory.prepared.sha256) 'Restart owner checkpoint preparation bytes changed'
    $retained = [Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Control 'lock'))
    try {
        $actual = $retained.CaptureIdentity()
        Assert ($actual.Dev -ceq $directory.directory.dev -and $actual.Ino -ceq $directory.directory.ino -and
            @(Get-ChildItem -LiteralPath (Join-Path $Control 'lock') -Force).Count -eq 0) `
            'Restart owner command requires its exact retained empty directory'
        $retained.Check()
    } finally { $retained.Dispose() }
    $Process.StandardInput.WriteLine('{"type":"publish-owner"}')
    $Process.StandardInput.Flush()
}
