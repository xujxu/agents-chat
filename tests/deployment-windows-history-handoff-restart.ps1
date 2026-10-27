function Test-AgentsChatStoppedHistoryHandoffRestart(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart.ps1')
    $request = @{
        Context=$Context; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    $refused = $false
    try { $null = Get-AgentsChatStoppedHistoryHandoffRestartRecord @request }
    catch {
        if ($_.Exception.Message -cne 'Restart preparation requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Read-only successor settlement accepted restart preparation.' }
    $Context.HistoryHandoffRestartPreparer = $true
    $settled = $Context.HistoryHandoffSuccessorAbandoned
    $timestamp = [DateTimeOffset]::ParseExact($settled.SettledAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    foreach ($case in @(
        @{ key='AttemptId'; value=$Context.HistoryHandoffSuccessorPrepared.Request.AttemptId },
        @{ key='AttemptId'; value=$Context.HistoryHandoffObservedCommit.AttemptId },
        @{ key='OperationId'; value=$Context.OperationId },
        @{ key='OperationId'; value=$Context.HistoryHandoffLock.OwnerRequest.OperationId },
        @{ key='Token'; value=$Context.HistoryHandoffLock.OwnerRequest.Token },
        @{ key='OperationId'; value=$Context.HistoryHandoffSuccessorPrepared.Request.OperationId },
        @{ key='Token'; value=$Context.HistoryHandoffSuccessorPrepared.Request.Token },
        @{ key='Token'; value=$request.OperationId },
        @{ key='ControllerPid'; value=$PID },
        @{ key='CreatedAt'; value=$timestamp.AddMilliseconds(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture) }
    )) {
        $bad = $request.Clone()
        $bad[$case.key] = $case.value
        $refused = $false
        try { $null = Get-AgentsChatStoppedHistoryHandoffRestartRecord @bad }
        catch {
            $message = if ($case.key -ceq 'ControllerPid') { 'Restart preparation controller differs.' }
                elseif ($case.key -ceq 'CreatedAt') { 'Lock retirement preparation predates commitment.' }
                else { 'Restart preparation requires fresh distinct owner identifiers.' }
            if ($_.Exception.Message -cne $message) { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Restart preparation accepted stale identifiers or time.' }
    }
    $record = Get-AgentsChatStoppedHistoryHandoffRestartRecord @request
    $expected = Read-AgentsChatRetirementJson ($Context.HistoryHandoffObservedCommit.Prepared.ReadText()) -AllowNull
    $expected.phase = 'stopped-history-handoff-restart-prepared'
    $expected.attemptId = $request.AttemptId
    $expected.newOwner = [ordered]@{
        version=1; token=$request.Token; project=$Context.Project; operationId=$request.OperationId
        pid=$ControllerPid; processIdentity=$ControllerIdentity; createdAt=$request.CreatedAt
    }
    $previous = $Context.HistoryHandoffObservedCommit
    $expected.predecessor = [ordered]@{
        attemptId=$Context.HistoryHandoffSuccessorPrepared.Request.AttemptId
        prepared=$Context.HistoryHandoffSuccessorPrepared.Descriptor
        abandoned=$settled.Descriptor
        predecessor=[ordered]@{
            attemptId=$previous.AttemptId; prepared=$previous.PreparedDescriptor; committed=$previous.CommittedDescriptor
            retirement=$Context.HistoryHandoffLockRetirementIntent.Descriptor
            terminal=$Context.HistoryHandoffLockSettlement.Descriptor
        }
    }
    $actualDocument = $expectedDocument = $null
    try {
        $text = $record | ConvertTo-Json -Depth 16 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 1048576) { throw 'Restart preparation is oversized.' }
        $actualDocument = [Text.Json.JsonDocument]::Parse($text)
        $expectedDocument = [Text.Json.JsonDocument]::Parse(($expected | ConvertTo-Json -Depth 16 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actualDocument.RootElement $expectedDocument.RootElement
    } finally {
        if ($actualDocument) { $actualDocument.Dispose() }
        if ($expectedDocument) { $expectedDocument.Dispose() }
    }
    return [ordered]@{
        version=$record.version; phase=$record.phase; attemptId=$record.attemptId
        newOwner=$record.newOwner; predecessor=$record.predecessor
    }
}
