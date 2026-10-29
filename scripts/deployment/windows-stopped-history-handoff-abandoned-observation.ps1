. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-observation.ps1')

function Get-AgentsChatStoppedHistoryHandoffAbandoned(
    [hashtable]$Context, $PreparedDescriptor, $TerminalDescriptor,
    [string]$AttemptId, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $document = $null
    try {
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        Assert-AgentsChatCompletionGuid $AttemptId
        Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
        $preparedName = "inactive-handoff-$AttemptId-prepared.json"
        $terminalName = "inactive-handoff-$AttemptId-abandoned.json"
        Assert-AgentsChatRetirementDescriptor $PreparedDescriptor $preparedName 1048576
        Assert-AgentsChatRetirementDescriptor $TerminalDescriptor $terminalName 65536
        $prepared = Open-AgentsChatRetirementFile $Context $PreparedDescriptor $preparedName
        $terminal = Open-AgentsChatRetirementFile $Context $TerminalDescriptor $terminalName
        $text = $terminal.ReadText()
        $record = Read-AgentsChatRetirementJson $text
        Assert-AgentsChatRetirementFields $record @(
            'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
            'previousOperationId', 'prepared', 'creator', 'settledAt'
        )
        if ($record.settledAt -isnot [string]) { throw 'Abandoned handoff settlement timestamp differs.' }
        $culture = [Globalization.CultureInfo]::InvariantCulture
        $style = [Globalization.DateTimeStyles]::AssumeUniversal
        $settled = [DateTimeOffset]::ParseExact($record.settledAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
        $preparedDocument = [Text.Json.JsonDocument]::Parse($prepared.ReadText())
        try {
            $created = $preparedDocument.RootElement.GetProperty('newOwner').GetProperty('createdAt').GetString()
            $createdTime = [DateTimeOffset]::ParseExact($created, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
            if ($settled -lt $createdTime) { throw 'Abandoned handoff settlement predates preparation.' }
        } finally { $preparedDocument.Dispose() }
        $document = [Text.Json.JsonDocument]::Parse($text)
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $terminalName)
            Assert-AgentsChatRetirementCreator $record.creator $ControllerPid $ControllerIdentity
            Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding $Context $prepared $AttemptId `
                $ControllerPid $ControllerIdentity
            $terminal.Check()
            if ($terminal.ReadText() -cne $text) { throw 'Abandoned handoff terminal bytes changed.' }
            $binding = [ordered]@{
                version=1; phase='stopped-history-handoff-abandoned'; attemptId=$AttemptId
                control=$Context.Control; project=$Context.Project
                controlIdentity=$Context.HistoryRecord.controlIdentity
                previousOperationId=$Context.OperationId
                prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
                creator=$record.creator; settledAt=$record.settledAt
            }
            $expected = [Text.Json.JsonDocument]::Parse(($binding | ConvertTo-Json -Depth 8 -Compress))
            try { Assert-AgentsChatStoppedHandoffJsonBinding $document.RootElement $expected.RootElement }
            finally { $expected.Dispose() }
            Assert-AgentsChatRetirementCreator $record.creator $ControllerPid $ControllerIdentity
            $null = Assert-AgentsChatStoppedWorkerCleanup $Context
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($preparedName, $terminalName)
        }
        return [ordered]@{
            status='abandoned-handoff-observed'; attemptId=$AttemptId
            prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
            terminal=(Get-AgentsChatStoppedHandoffDescriptor $terminal $terminalName 65536)
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Abandoned handoff observation failed; retain evidence.', $_.Exception)
    } finally {
        if ($document) { $document.Dispose() }
    }
}
