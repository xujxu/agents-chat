function Stop-AgentsChatRestartRetirementPublisher(
    [string]$Node, [string]$Source, [string]$Control, [string]$Pwsh,
    $Environment, [string]$HistoryActor, [string]$StateHash
) {
    $dead = $HistoryActor | ConvertFrom-Json
    $ownerHash = (Get-FileHash -LiteralPath (Join-Path $Control 'lock\owner.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert ($ownerHash -ceq $dead.restartOwner.sha256) 'Restart retirement death fixture began with different owner bytes'
    $retirer = [Deployment.WindowsControllerProcess]::Start($Node,
        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
            $Source, $Control, $Pwsh, 'crash-restart-retirement-history', $HistoryActor), $Control, $Environment)
    try {
        $diagnostic = $retirer.StandardError.ReadToEndAsync()
        $prefix = 'INACTIVE_HISTORY_RESTART_RETIREMENT_HELD '
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            $line = $retirer.StandardOutput.ReadLineAsync()
            $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
            Assert ($line.Wait([int]$remaining)) 'Restart lock retirer did not publish its held intent'
            $text = $line.GetAwaiter().GetResult()
            if ($null -eq $text) {
                Assert ($retirer.WaitForExit(15000)) 'Restart lock retirer closed output without exiting'
                [Console]::Error.WriteLine($diagnostic.GetAwaiter().GetResult())
                throw 'Restart lock retirer exited before its held intent'
            }
            if ($text.StartsWith($prefix)) { break }
            [Console]::Out.WriteLine($text)
            Assert ($clock.ElapsedMilliseconds -lt 120000) 'Restart lock retirer exceeded actor budget'
        }
        $metadata = $text.Substring($prefix.Length)
        $held = $metadata | ConvertFrom-Json
        $actor = $held.restartRetirerActor
        Assert ($actor.actorPid -eq $retirer.Id -and $actor.actorIdentity -cne $dead.actorIdentity -and
            [Deployment.WindowsWorkerJob]::ProcessIdentity($actor.actorPid) -ceq $actor.actorIdentity -and
            $actor.pid -ne $dead.pid -and
            [Deployment.WindowsWorkerJob]::ProcessIdentity($actor.pid) -ceq $actor.processIdentity) `
            'Held restart lock retirer lost its actual live actor or bridge'
        Assert ($held.actorPid -eq $dead.actorPid -and $held.actorIdentity -ceq $dead.actorIdentity -and
            $held.pid -eq $dead.pid -and $held.processIdentity -ceq $dead.processIdentity) `
            'Held restart lock retirer replaced its dead committed owner'
        $bridge = [Diagnostics.Process]::GetProcessById($actor.pid)
        try {
            $null = $bridge.Handle
            $retirer.Kill()
            Assert ($retirer.WaitForExit(15000)) 'Restart lock retirer survived actual death'
            Assert ($bridge.WaitForExit(15000)) 'Restart lock retirement bridge survived actual retirer death'
        } finally { $bridge.Dispose() }
        $errors = $diagnostic.GetAwaiter().GetResult()
        if ($errors) { [Console]::Error.WriteLine($errors) }
        $retirementName = $held.restartPrepared.path -creplace '-prepared\.json$', '-lock-retirement.json'
        Assert ($held.restartRetirement.path -ceq $retirementName -and $retirementName -cne $held.restartPrepared.path) `
            'Restart lock retirer death changed its intent name'
        foreach ($descriptor in @($held.prepared, $held.committed, $held.retirement, $held.terminal, $held.successor,
            $held.successorAbandoned, $held.restartPrepared, $held.restartCommitted, $held.restartRetirement)) {
            Assert ((Get-FileHash -LiteralPath (Join-Path $Control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                $descriptor.sha256) 'Restart lock retirer death changed immutable evidence'
        }
        $children = @(Get-ChildItem -LiteralPath (Join-Path $Control 'lock') -Force)
        Assert ($children.Count -eq 1 -and $children[0].Name -ceq 'owner.json' -and -not $children[0].PSIsContainer -and
            (Get-FileHash -LiteralPath (Join-Path $Control 'lock\owner.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
            $ownerHash) 'Restart lock retirer death changed the dead owner or directory'
        Assert (-not (Test-Path -LiteralPath (Join-Path $Control 'state.json.lock')) -and
            (Get-FileHash -LiteralPath (Join-Path $Control 'state.json') -Algorithm SHA256).Hash -ceq $StateHash) `
            'Restart lock retirer death changed original state'
        return $metadata
    } finally { $retirer.Dispose() }
}
