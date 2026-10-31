function Send-AgentsChatRestartStateWriteCommand($Process, $Diagnostic, $Live, [string]$Control) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $line = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
        Assert ($line.Wait([int]$remaining)) 'Live restart state intent stage timed out before state write'
        $text = $line.GetAwaiter().GetResult()
        if ($null -eq $text) {
            Assert ($Process.WaitForExit(15000)) 'Live restart state intent closed output without exiting'
            [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
            throw 'Live restart state intent exited before state write checkpoint'
        }
        if ($text.StartsWith('INACTIVE_HISTORY_RESTART_STATE_INTENT_LIVE ')) { break }
        [Console]::Out.WriteLine($text)
        Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart state intent stage exceeded budget'
    }
    $intent = $text.Substring('INACTIVE_HISTORY_RESTART_STATE_INTENT_LIVE '.Length) | ConvertFrom-Json
    Assert ($intent.actorPid -eq $Process.Id -and $intent.actorIdentity -ceq $Live.actorIdentity -and
        $intent.pid -eq $Live.pid -and $intent.processIdentity -ceq $Live.processIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($intent.actorPid) -ceq $intent.actorIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($intent.pid) -ceq $intent.processIdentity) `
        'Restart state write checkpoint changed its actual live owner or bridge'
    $intentName = $Live.prepared.path -creplace '-prepared\.json$', '-state-intent.json'
    Assert ($intent.stateIntent.path -ceq $intentName -and $intentName -cne $Live.prepared.path -and
        (Get-FileHash -LiteralPath (Join-Path $Control $intentName) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $intent.stateIntent.sha256) 'Restart state write requires its exact ninth record'
    Assert (-not (Test-Path -LiteralPath (Join-Path $Control 'state.json.lock'))) 'Restart state stage appeared before its exact command'
    $Process.StandardInput.WriteLine('{"type":"write-restart-state"}')
    $Process.StandardInput.Flush()
}
