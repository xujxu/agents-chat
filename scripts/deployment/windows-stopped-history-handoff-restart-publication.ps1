. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRestartPrepared([hashtable]$Context) {
    $publisher = $Context.ContainsKey('HistoryHandoffRestartPublisher') -and
        $Context.HistoryHandoffRestartPublisher -eq $true -and
        $Context.ContainsKey('HistoryHandoffRestartPreparer') -and
        $Context.HistoryHandoffRestartPreparer -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartObserver')
    $observer = $Context.ContainsKey('HistoryHandoffRestartObserver') -and
        $Context.HistoryHandoffRestartObserver -eq $true -and
        -not $Context.ContainsKey('HistoryHandoffRestartPreparer') -and
        -not $Context.ContainsKey('HistoryHandoffRestartPublisher')
    if ($publisher -eq $observer -or
        -not $Context.ContainsKey('HistoryHandoffRestartPrepared')) {
        throw 'Restart preparation lacks retained independent publication proof.'
    }
    $retained = $Context.HistoryHandoffRestartPrepared
    $name = "inactive-handoff-$($retained.Request.AttemptId)-prepared.json"
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) {
            throw 'Restart prepared descriptor differs.'
        }
    }
    $request = $retained.Request
    $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @request
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 16 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}

function Publish-AgentsChatStoppedHistoryHandoffRestartPrepared(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartPublisher') -or
        $Context.HistoryHandoffRestartPublisher -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffRestartPreparer') -or
        $Context.HistoryHandoffRestartPreparer -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart publication requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffRestartPrepared')) {
            throw 'Restart preparation already retained.'
        }
        $null = Get-AgentsChatStoppedHistoryHandoffRestartBinding @PSBoundParameters
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding @PSBoundParameters
        $name = "inactive-handoff-$AttemptId-prepared.json"
        $file = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control $name), ($record | ConvertTo-Json -Depth 16 -Compress))
        $Context.Files.Add($file)
        $Context.HistoryHandoffRestartPrepared = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name 1048576)
            Request=@{
                ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
                AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
            }
        }
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
        return $Context.HistoryHandoffRestartPrepared.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart publication failed; retain evidence.', $_.Exception)
    }
}
