function Test-AgentsChatStoppedHistoryHandoffSuccessor(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-successor.ps1')
    $request = @{
        Context=$Context; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    function Assert-SuccessorRefused([hashtable]$InputRequest, [string]$Message) {
        $refused = $false
        try { $null = Get-AgentsChatStoppedHistoryHandoffSuccessorRecord @InputRequest }
        catch {
            if ($_.Exception.Message -cne $Message) { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Successor preparation accepted invalid authority or replayed scalar input.' }
    }
    Assert-SuccessorRefused $request 'Successor preparation requires its independent native role.'
    $Context.HistoryHandoffSuccessorPreparer = $true
    $Context.HistoryHandoffLockSettler = $true
    try { Assert-SuccessorRefused $request 'Successor preparation requires its independent native role.' }
    finally { $Context.Remove('HistoryHandoffLockSettler') }
    $Context.HistoryHandoffLockSettlementObserver = $false
    try { Assert-SuccessorRefused $request 'Successor preparation requires its independent native role.' }
    finally { $Context.HistoryHandoffLockSettlementObserver = $true }
    $old = $Context.HistoryHandoffLock.OwnerRequest
    foreach ($case in @(
        @{ field='AttemptId'; value=$Context.HistoryHandoffObservedCommit.AttemptId },
        @{ field='OperationId'; value=$old.OperationId },
        @{ field='Token'; value=$old.Token },
        @{ field='Token'; value=$request.AttemptId },
        @{ field='OperationId'; value=$request.AttemptId }
    )) {
        $invalid = $request.Clone()
        $invalid[$case.field] = $case.value
        Assert-SuccessorRefused $invalid 'Successor preparation requires fresh distinct owner identifiers.'
    }
    $invalid = $request.Clone()
    $invalid.CreatedAt = '1970-01-01T00:00:00.000Z'
    Assert-SuccessorRefused $invalid 'Lock retirement preparation predates commitment.'
    return Get-AgentsChatStoppedHistoryHandoffSuccessorRecord @request
}
