function Send-AgentsChatRestartReleaseCommand($Process, $Diagnostic, $Live, [string]$Control) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $line = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
        Assert ($line.Wait([int]$remaining)) 'Live restart committed stage timed out before release'
        $text = $line.GetAwaiter().GetResult()
        if ($null -eq $text) {
            Assert ($Process.WaitForExit(15000)) 'Live restart committed owner closed output without exiting'
            [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
            throw 'Live restart committed owner exited before release checkpoint'
        }
        if ($text.StartsWith('INACTIVE_HISTORY_RESTART_COMMITTED_LIVE ')) { break }
        [Console]::Out.WriteLine($text)
        Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart committed stage exceeded budget'
    }
    $committed = $text.Substring('INACTIVE_HISTORY_RESTART_COMMITTED_LIVE '.Length) | ConvertFrom-Json
    Assert ($committed.actorPid -eq $Process.Id -and $committed.actorIdentity -ceq $Live.actorIdentity -and
        $committed.pid -eq $Live.pid -and $committed.processIdentity -ceq $Live.processIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($committed.actorPid) -ceq $committed.actorIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($committed.pid) -ceq $committed.processIdentity) `
        'Restart release checkpoint changed its actual live owner or bridge'
    $committedName = $Live.prepared.path -creplace '-prepared\.json$', '-committed.json'
    Assert ($committed.committed.path -ceq $committedName -and $committedName -cne $Live.prepared.path -and
        (Get-FileHash -LiteralPath (Join-Path $Control $committedName) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $committed.committed.sha256) 'Restart release requires its exact eighth record'
    Assert ($committed.owner.path -ceq 'lock\owner.json' -and
        (Get-FileHash -LiteralPath (Join-Path $Control $committed.owner.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $committed.owner.sha256) 'Restart release owner bytes changed before its command'
    Assert ((Test-Path -LiteralPath (Join-Path $Control 'lock\owner.json') -PathType Leaf) -and
        -not (Test-Path -LiteralPath (Join-Path $Control ($Live.prepared.path -creplace '-prepared\.json$', '-lock-retirement.json')))) `
        'Restart release began before its exact command'
    $Process.StandardInput.WriteLine('{"type":"release-restart"}')
    $Process.StandardInput.Flush()
}
