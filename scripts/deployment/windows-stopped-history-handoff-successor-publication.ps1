. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-successor.ps1')

function Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared([hashtable]$Context) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorPublisher') -or
        $Context.HistoryHandoffSuccessorPublisher -ne $true -or
        -not $Context.ContainsKey('HistoryHandoffSuccessorPrepared')) {
        throw 'Successor preparation lacks retained independent publication proof.'
    }
    $retained = $Context.HistoryHandoffSuccessorPrepared
    $name = "inactive-handoff-$($retained.Request.AttemptId)-prepared.json"
    $descriptor = Get-AgentsChatStoppedHandoffDescriptor $retained.File $name 1048576
    foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
        if ($descriptor[$field] -cne $retained.Descriptor[$field]) { throw 'Successor prepared descriptor differs.' }
    }
    $request = $retained.Request
    $record = Get-AgentsChatStoppedHistoryHandoffSuccessorBinding -Context $Context @request
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($retained.File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($record | ConvertTo-Json -Depth 12 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
}

function Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffSuccessorPublisher') -or
        $Context.HistoryHandoffSuccessorPublisher -ne $true) {
        throw 'Successor publication requires its independent native role.'
    }
    try {
        if ($Context.ContainsKey('HistoryHandoffSuccessorPrepared')) { throw 'Successor preparation already retained.' }
        $record = Get-AgentsChatStoppedHistoryHandoffSuccessorRecord @PSBoundParameters
        Assert-AgentsChatStoppedHistoryHandoffLock $Context
        $name = "inactive-handoff-$AttemptId-prepared.json"
        $file = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $Context.Control $name), ($record | ConvertTo-Json -Depth 12 -Compress))
        $Context.Files.Add($file)
        $Context.HistoryHandoffSuccessorPrepared = @{
            File=$file; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $file $name 1048576)
            Request=@{
                ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
                AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
            }
        }
        foreach ($pass in @(1, 2)) {
            $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
        }
        return $Context.HistoryHandoffSuccessorPrepared.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Successor publication failed; retain evidence.', $_.Exception)
    }
}

function Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
        foreach ($pass in @(1, 2)) {
            $null = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Context $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared $Context
        }
        $retained = $Context.HistoryHandoffSuccessorPrepared
        $request = $retained.Request
        $record = Get-AgentsChatStoppedHistoryHandoffSuccessorBinding -Context $Context @request
        return [ordered]@{
            status='successor-prepared'; attemptId=$record.attemptId
            previousAttemptId=$record.predecessor.attemptId
            previousOperationId=$record.previousOperationId; project=$record.project
            prepared=$retained.Descriptor; predecessor=$record.predecessor
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Successor prepared observation failed; retain evidence.', $_.Exception)
    }
}
