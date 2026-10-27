function Test-AgentsChatStoppedHistoryHandoffRestartPublication(
    [string]$Source, [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-publication.ps1')
    . (Join-Path $PSScriptRoot 'deployment-windows-history-handoff-restart.ps1')
    $request = @{
        Context=$Context; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    $Context.HistoryHandoffRestartPreparer = $true
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Restart publication requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Restart preparation gained publication authority.' }
    $Context.HistoryHandoffRestartPublisher = $true
    $descriptor = Publish-AgentsChatStoppedHistoryHandoffRestartPrepared @request
    $retained = $Context.HistoryHandoffRestartPrepared
    $text = $retained.File.ReadText()
    $record = Read-AgentsChatRetirementJson $text -AllowNull
    $projection = Get-AgentsChatTestRestartProjection $Context $ControllerPid $ControllerIdentity $request $record
    Assert-AgentsChatStoppedHistoryHandoffRestartPrepared $Context
    $refused = $false
    try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartPrepared @request }
    catch {
        if ($_.Exception.Message -cne 'Restart publication failed; retain evidence.') { throw }
        $refused = $true
    }
    if (-not $refused -or -not $Context.Poisoned -or $retained.File.ReadText() -cne $text) {
        throw 'Duplicate restart publication failed to preserve and poison.'
    }
    return [ordered]@{ prepared=$descriptor; record=$projection }
}
