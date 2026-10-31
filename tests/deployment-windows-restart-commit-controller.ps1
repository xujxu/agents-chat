function Send-AgentsChatRestartCommitCommand($Process, $Diagnostic, $Live, [string]$Control) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $line = $Process.StandardOutput.ReadLineAsync()
        $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
        Assert ($line.Wait([int]$remaining)) 'Live restart owner stage timed out before commitment'
        $text = $line.GetAwaiter().GetResult()
        if ($null -eq $text) {
            Assert ($Process.WaitForExit(15000)) 'Live restart owner closed output without exiting'
            [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
            throw 'Live restart owner exited before commitment checkpoint'
        }
        if ($text.StartsWith('INACTIVE_HISTORY_RESTART_OWNER_LIVE ')) { break }
        [Console]::Out.WriteLine($text)
        Assert ($clock.ElapsedMilliseconds -lt 120000) 'Live restart owner stage exceeded budget'
    }
    $owner = $text.Substring('INACTIVE_HISTORY_RESTART_OWNER_LIVE '.Length) | ConvertFrom-Json
    Assert ($owner.actorPid -eq $Process.Id -and $owner.actorIdentity -ceq $Live.actorIdentity -and
        $owner.pid -eq $Live.pid -and $owner.processIdentity -ceq $Live.processIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($owner.actorPid) -ceq $owner.actorIdentity -and
        [Deployment.WindowsWorkerJob]::ProcessIdentity($owner.pid) -ceq $owner.processIdentity) `
        'Restart commitment checkpoint changed its actual live owner or bridge'
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        Assert ($owner.prepared.$field -ceq $Live.prepared.$field) 'Restart commitment changed its preparation'
    }
    Assert ($owner.owner.path -ceq 'lock\owner.json' -and
        (Get-FileHash -LiteralPath (Join-Path $Control $owner.owner.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $owner.owner.sha256) 'Restart commitment owner bytes changed'
    $record = Get-Content -LiteralPath (Join-Path $Control $owner.owner.path) -Raw | ConvertFrom-Json
    Assert ($record.pid -eq $Process.Id -and $record.processIdentity -ceq $Live.actorIdentity) `
        'Restart commitment does not bind its actual owner'
    $retained = [Deployment.WindowsPrivateFile]::OpenDirectory((Join-Path $Control 'lock'))
    try {
        $actual = $retained.CaptureIdentity()
        $children = @(Get-ChildItem -LiteralPath (Join-Path $Control 'lock') -Force)
        Assert ($actual.Dev -ceq $owner.directory.dev -and $actual.Ino -ceq $owner.directory.ino -and
            $children.Count -eq 1 -and $children[0].Name -ceq 'owner.json' -and -not $children[0].PSIsContainer) `
            'Restart commitment requires its exact retained owner directory'
        $retained.Check()
    } finally { $retained.Dispose() }
    $committedName = $owner.prepared.path -creplace '-prepared\.json$', '-committed.json'
    Assert ($committedName -cne $owner.prepared.path -and
        -not (Test-Path -LiteralPath (Join-Path $Control $committedName))) 'Restart commitment appeared before its exact command'
    $Process.StandardInput.WriteLine('{"type":"commit-restart"}')
    $Process.StandardInput.Flush()
}
