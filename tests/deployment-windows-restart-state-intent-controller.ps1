function Send-AgentsChatRestartStateIntentCommand($Process, $Diagnostic, $Live, [string]$Control) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $line = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
        Assert ($line.Wait([int]$remaining)) 'Live restart commitment stage timed out before state intent'
        $text = $line.GetAwaiter().GetResult()
        if ($null -eq $text) {
            Assert ($Process.WaitForExit(15000)) 'Live restart commitment closed output without exiting'
            [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
            throw 'Live restart commitment exited before state intent checkpoint'
        }
        if ($text.StartsWith('INACTIVE_HISTORY_RESTART_COMMITTED_LIVE ')) { break }
        [Console]::Out.WriteLine($text)
        Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart commitment stage exceeded budget'
    }
    $committed = $text.Substring('INACTIVE_HISTORY_RESTART_COMMITTED_LIVE '.Length) | ConvertFrom-Json
    Assert ($committed.actorPid -eq $Process.Id -and $committed.actorIdentity -ceq $Live.actorIdentity -and
        $committed.pid -eq $Live.pid -and $committed.processIdentity -ceq $Live.processIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($committed.actorPid) -ceq $committed.actorIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($committed.pid) -ceq $committed.processIdentity) `
        'Restart state intent checkpoint changed its actual live owner or bridge'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        Assert ($committed.prepared.$field -ceq $Live.prepared.$field) 'Restart state intent changed its preparation'
    }
    $committedName = $committed.prepared.path -creplace '-prepared\.json$', '-committed.json'
    Assert ($committed.committed.path -ceq $committedName -and $committedName -cne $committed.prepared.path -and
        (Get-FileHash -LiteralPath (Join-Path $Control $committedName) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $committed.committed.sha256) 'Restart state intent requires its exact eighth record'
    Assert ($committed.owner.path -ceq 'lock\owner.json' -and
        (Get-FileHash -LiteralPath (Join-Path $Control $committed.owner.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $committed.owner.sha256) 'Restart state intent owner bytes changed'
    $intentName = $committed.prepared.path -creplace '-prepared\.json$', '-state-intent.json'
    Assert ($intentName -cne $committed.prepared.path -and
        -not (Test-Path -LiteralPath (Join-Path $Control $intentName))) 'Restart state intent appeared before its exact command'
    $Process.StandardInput.WriteLine('{"type":"prepare-restart-state"}')
    $Process.StandardInput.Flush()
}
