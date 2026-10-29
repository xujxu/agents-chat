function Stop-AgentsChatRestartDirectoryPublisher(
    [string]$Node, [string]$Source, [string]$Control, [string]$Pwsh,
    $Environment, [string]$HistoryActor, [string]$StateHash, [switch]$Owner, [switch]$Committed
) {
    if ($Committed) { $Owner = $true }
    function Read-RestartDirectoryCheckpoint($Process, $Diagnostic, [string]$Prefix) {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            $line = $Process.StandardOutput.ReadLineAsync()
            $remaining = [Math]::Max(1, 120000 - $clock.ElapsedMilliseconds)
            Assert ($line.Wait([int]$remaining)) 'Restart directory publication stage timed out'
            $text = $line.GetAwaiter().GetResult()
            if ($null -eq $text) {
                Assert ($Process.WaitForExit(15000)) 'Restart directory publisher closed output without exiting'
                [Console]::Error.WriteLine($Diagnostic.GetAwaiter().GetResult())
                throw 'Restart directory publisher exited before its checkpoint'
            }
            if ($text.StartsWith($Prefix)) { return $text.Substring($Prefix.Length) }
            [Console]::Out.WriteLine($text)
            Assert ($clock.ElapsedMilliseconds -lt 120000) 'Restart directory publication stage exceeded budget'
        }
    }
    $publisher = [Deployment.WindowsControllerProcess]::Start($Node,
        @((Join-Path $PSScriptRoot 'deployment-windows-lost-runtime-session.mjs'),
            $Source, $Control, $Pwsh,
            $(if ($Committed) { 'crash-restart-committed-history' } elseif ($Owner) { 'crash-restart-owner-history' } else { 'crash-restart-directory-history' }),
            $HistoryActor), $Control, $Environment)
    try {
        $diagnostic = $publisher.StandardError.ReadToEndAsync()
        $live = (Read-RestartDirectoryCheckpoint $publisher $diagnostic 'INACTIVE_HISTORY_RESTART_PREPARED_LIVE ') |
            ConvertFrom-Json
        Assert ($live.actorPid -eq $publisher.Id -and
            [Deployment.WindowsWorkerJob]::ProcessIdentity($live.actorPid) -ceq $live.actorIdentity -and
            [Deployment.WindowsWorkerJob]::ProcessIdentity($live.pid) -ceq $live.processIdentity) `
            'Restart directory death fixture lost its actual live publisher or bridge'
        Assert ((Get-FileHash -LiteralPath (Join-Path $Control $live.prepared.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
            $live.prepared.sha256) 'Restart directory death fixture preparation changed'
        Assert (-not (Test-Path -LiteralPath (Join-Path $Control 'lock'))) 'Restart directory appeared before explicit command'
        $publisher.StandardInput.WriteLine('{"type":"create-directory"}')
        $publisher.StandardInput.Flush()
        if ($Owner) {
            . (Join-Path $PSScriptRoot 'deployment-windows-restart-owner-controller.ps1')
            Send-AgentsChatRestartOwnerCommand $publisher $diagnostic $live $Control
        }
        if ($Committed) {
            . (Join-Path $PSScriptRoot 'deployment-windows-restart-commit-controller.ps1')
            Send-AgentsChatRestartCommitCommand $publisher $diagnostic $live $Control
        }
        $prefix = if ($Committed) { 'INACTIVE_HISTORY_RESTART_COMMITTED_HELD ' } elseif ($Owner) { 'INACTIVE_HISTORY_RESTART_OWNER_HELD ' } else { 'INACTIVE_HISTORY_RESTART_DIRECTORY_HELD ' }
        $metadata = Read-RestartDirectoryCheckpoint $publisher $diagnostic $prefix
        $held = $metadata | ConvertFrom-Json
        Assert ($held.actorPid -eq $publisher.Id -and $held.actorIdentity -ceq $live.actorIdentity -and
            $held.pid -eq $live.pid -and $held.processIdentity -ceq $live.processIdentity -and
            [Deployment.WindowsWorkerJob]::ProcessIdentity($held.pid) -ceq $held.processIdentity) `
            'Held restart directory changed its actual publishing bridge'
        $bridge = [Diagnostics.Process]::GetProcessById($held.pid)
        try {
            $null = $bridge.Handle
            $publisher.Kill()
            Assert ($publisher.WaitForExit(15000)) 'Restart directory publisher survived actual death'
            Assert ($bridge.WaitForExit(15000)) 'Restart directory bridge survived actual publisher death'
        } finally { $bridge.Dispose() }
        $errors = $diagnostic.GetAwaiter().GetResult()
        if ($errors) { [Console]::Error.WriteLine($errors) }
        foreach ($descriptor in @($held.prepared, $held.committed, $held.retirement,
            $held.terminal, $held.successor, $held.successorAbandoned, $held.restartPrepared) +
            @($(if ($Committed) { $held.restartCommitted }))) {
            Assert ((Get-FileHash -LiteralPath (Join-Path $Control $descriptor.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                $descriptor.sha256) 'Restart directory publisher death changed immutable evidence'
        }
        Assert (Test-Path -LiteralPath (Join-Path $Control 'lock') -PathType Container) `
            'Restart directory publisher death removed incomplete evidence'
        $children = @(Get-ChildItem -LiteralPath (Join-Path $Control 'lock') -Force)
        if ($Owner) {
            Assert ($children.Count -eq 1 -and $children[0].Name -ceq 'owner.json' -and -not $children[0].PSIsContainer) `
                'Restart owner publisher death changed its exact child inventory'
            Assert ($held.restartOwner.path -ceq 'lock\owner.json' -and
                (Get-FileHash -LiteralPath (Join-Path $Control $held.restartOwner.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
                $held.restartOwner.sha256) 'Restart owner publisher death changed owner bytes'
            if ($Committed) {
                Assert ($held.restartCommitted.path -ceq ($held.restartPrepared.path -creplace '-prepared\.json$', '-committed.json') -and
                    $held.restartCommitted.path -cne $held.restartPrepared.path) 'Restart committed publisher death changed its record name'
            } else {
                $committedName = $held.restartPrepared.path -creplace '-prepared\.json$', '-committed.json'
                Assert (-not (Test-Path -LiteralPath (Join-Path $Control $committedName))) 'Restart owner publisher death introduced commitment'
            }
        } else {
            Assert ($children.Count -eq 0) 'Restart directory publisher death introduced an owner or foreign child'
        }
        Assert ((Get-FileHash -LiteralPath (Join-Path $Control 'state.json') -Algorithm SHA256).Hash -ceq
            $StateHash) 'Restart directory publisher death changed original state'
        return $metadata
    } finally { $publisher.Dispose() }
}
