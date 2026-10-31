. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-record.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-json.ps1')

function Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding(
    [hashtable]$Context, [string]$AttemptId, [hashtable]$OwnerRequest, $File
) {
    $File.Check()
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @OwnerRequest
    $binding = Get-AgentsChatStoppedHistoryHandoffBinding $Context $AttemptId $owner
    $actual = $expected = $null
    try {
        $actual = [Text.Json.JsonDocument]::Parse($File.ReadText())
        $expected = [Text.Json.JsonDocument]::Parse(($binding | ConvertTo-Json -Depth 12 -Compress))
        Assert-AgentsChatStoppedHandoffJsonBinding $actual.RootElement $expected.RootElement
    } finally {
        if ($actual) { $actual.Dispose() }
        if ($expected) { $expected.Dispose() }
    }
    $null = New-AgentsChatStoppedHistoryHandoffOwner @OwnerRequest
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
}
