function Test-AgentsChatStoppedHistoryHandoffSuccessorPublication(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [switch]$Hold
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-successor-publication.ps1')
    $trace = [Environment]::GetEnvironmentVariable('AGENTS_CHAT_TEST_SUCCESSOR_TRACE')
    if ($trace) {
        $global:AgentsChatSuccessorPublicationTrace = $trace
        $null = Set-PSBreakpoint -Command @(
            'Get-AgentsChatStoppedHistoryHandoffSuccessorRecord',
            'Get-AgentsChatStoppedHistoryHandoffSuccessorBinding',
            'Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation',
            'Assert-AgentsChatStoppedHistoryHandoffSuccessorPrepared',
            'Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation'
        ) -Action {
            [IO.File]::AppendAllText($global:AgentsChatSuccessorPublicationTrace,
                "$([DateTime]::UtcNow.ToString('O')) $($PSDebugContext.InvocationInfo.MyCommand.Name)`n")
        }
        [IO.File]::AppendAllText($trace, "$([DateTime]::UtcNow.ToString('O')) publication-fixture-entered`n")
    }
    $request = @{
        Context=$Context; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    $Context.HistoryHandoffSuccessorPreparer = $true
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Successor publication requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Successor publication accepted a scope without its independent role.' }
    $Context.HistoryHandoffSuccessorPublisher = $true
    $descriptor = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request
    if ($trace) { [IO.File]::AppendAllText($trace, "$([DateTime]::UtcNow.ToString('O')) publication-returned`n") }
    $file = Join-Path $Context.Control $descriptor.path
    $Record = Read-AgentsChatRetirementJson ([IO.File]::ReadAllText($file)) -AllowNull
    if ($Record.attemptId -cne $request.AttemptId -or
        $Record.newOwner.operationId -cne $request.OperationId -or $Record.newOwner.token -cne $request.Token -or
        $Record.newOwner.createdAt -cne $request.CreatedAt -or $Record.newOwner.pid -ne $ControllerPid -or
        $Record.newOwner.processIdentity -cne $ControllerIdentity) {
        throw 'Published successor differs from its actual scalar request.'
    }
    $observed = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $Context $ControllerPid $ControllerIdentity
    if ($trace) { [IO.File]::AppendAllText($trace, "$([DateTime]::UtcNow.ToString('O')) observation-returned`n") }
    if ($Hold) { return [ordered]@{ prepared=$descriptor; record=$Record; observation=$observed } }
    $bytes = [IO.File]::ReadAllBytes($file)
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Successor publication failed; retain evidence.') { throw }
        $refused = $true
    }
    if (-not $refused -or
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -cne [Convert]::ToBase64String($bytes)) {
        throw 'Duplicate successor publication replaced its immutable evidence.'
    }
    return [ordered]@{ prepared=$descriptor; record=$Record; observation=$observed }
}
