. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-record.ps1')

function Publish-AgentsChatStoppedHistoryHandoffPrepared(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    if (-not $Context.ContainsKey('HistoryHandoffPreparer') -or
        $Context.HistoryHandoffPreparer -ne $true) {
        throw 'Prepared handoff publication requires its independent native role.'
    }
    $record = Get-AgentsChatStoppedHistoryHandoffPreparedRecord $Context $ControllerPid $ControllerIdentity `
        $AttemptId $OperationId $Token $CreatedAt
    $text = $record | ConvertTo-Json -Depth 12 -Compress
    $name = "inactive-handoff-$AttemptId-prepared.json"
    $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $name), $text)
    $Context.Files.Add($held)
    try {
        $held.Check()
        if ($held.ReadText() -cne $text) { throw 'Published prepared handoff differs.' }
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Prepared handoff original actor changed.'
        }
        $entries = @(Get-ChildItem -LiteralPath $Context.Control -Force |
            Where-Object { $_.Name -like 'inactive-handoff-*' })
        if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Name -cne $name) {
            throw 'Prepared handoff namespace changed during publication.'
        }
        return Get-AgentsChatStoppedHandoffDescriptor $held $name 1048576
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Prepared handoff publication failed; retain evidence.', $_.Exception)
    }
}
