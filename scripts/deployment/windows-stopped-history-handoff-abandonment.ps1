. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-observation.ps1')

function Publish-AgentsChatStoppedHistoryHandoffAbandoned(
    [hashtable]$Context, $Descriptor, [string]$AttemptId,
    [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffAbandoner') -or
        $Context.HistoryHandoffAbandoner -ne $true) {
        throw 'Abandoned handoff publication requires its independent native role.'
    }
    try {
        $null = Get-AgentsChatStoppedHistoryHandoffRetiredPrepared $Context $Descriptor $AttemptId `
            $ControllerPid $ControllerIdentity
        $preparedName = "inactive-handoff-$AttemptId-prepared.json"
        $terminalName = "inactive-handoff-$AttemptId-abandoned.json"
        $prepared = Open-AgentsChatRetirementFile $Context $Descriptor $preparedName
        $settled = [DateTime]::UtcNow
        $document = [Text.Json.JsonDocument]::Parse($prepared.ReadText())
        try {
            $created = $document.RootElement.GetProperty('newOwner').GetProperty('createdAt').GetString()
            $createdTime = [DateTimeOffset]::ParseExact($created, 'yyyy-MM-ddTHH:mm:ss.fffZ',
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
            if ($createdTime -gt [DateTimeOffset]$settled) { throw 'Abandoned handoff settlement predates preparation.' }
        } finally { $document.Dispose() }
        $record = [ordered]@{
            version=1; phase='stopped-history-handoff-abandoned'; attemptId=$AttemptId
            control=$Context.Control; project=$Context.Project
            controlIdentity=$Context.HistoryRecord.controlIdentity
            previousOperationId=$Context.OperationId
            prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
            creator=[ordered]@{
                pid=$ControllerPid; processIdentity=$ControllerIdentity
                bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            }
            settledAt=$settled.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        }
        $text = $record | ConvertTo-Json -Depth 8 -Compress
        $held = [Deployment.WindowsPrivateFile]::Publish((Join-Path $Context.Control $terminalName), $text)
        $Context.Files.Add($held)
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $terminalName)
            $held.Check()
            if ($held.ReadText() -cne $text) { throw 'Published abandoned handoff differs.' }
            Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding $Context $prepared $AttemptId `
                $ControllerPid $ControllerIdentity
            $null = Assert-AgentsChatStoppedWorkerCleanup $Context
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $terminalName)
        }
        return Get-AgentsChatStoppedHandoffDescriptor $held $terminalName
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Abandoned handoff publication failed; retain evidence.', $_.Exception)
    }
}
