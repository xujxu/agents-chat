. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-record.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-json.ps1')
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-namespace.ps1')

function Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding(
    [hashtable]$Context, $File, [string]$AttemptId,
    [int]$ControllerPid, [string]$ControllerIdentity
) {
    $document = $null
    try {
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        Assert-AgentsChatCompletionGuid $AttemptId
        Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
        $held = $File
        $text = $held.ReadText()
        $fields = Read-AgentsChatMaintenanceFields $text @(
            'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
            'previousOperationId', 'operation', 'oldState', 'state', 'intent',
            'completion', 'newOwner', 'observation'
        )
        if ($fields.attemptId.GetString() -cne $AttemptId) { throw 'Prepared attempt binding differs.' }
        $ownerFields = Read-AgentsChatMaintenanceFields ($fields.newOwner.GetRawText()) @(
            'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt'
        )
        $request = @{
            Project=$Context.Project; PreviousOperationId=$Context.OperationId; AttemptId=$AttemptId
            OperationId=$ownerFields.operationId.GetString(); Token=$ownerFields.token.GetString()
            CreatedAt=$ownerFields.createdAt.GetString()
            PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
            ControllerPid=$ownerFields.pid.GetInt32()
            ControllerIdentity=$ownerFields.processIdentity.GetString()
        }
        $document = [Text.Json.JsonDocument]::Parse($text)
        foreach ($pass in @(1, 2)) {
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
                throw 'Retired prepared observer identity differs.'
            }
            $held.Check()
            if ($held.ReadText() -cne $text) { throw 'Retired prepared handoff bytes changed.' }
            $owner = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
            $binding = Get-AgentsChatStoppedHistoryHandoffBinding $Context $AttemptId $owner
            $expected = [Text.Json.JsonDocument]::Parse(($binding | ConvertTo-Json -Depth 12 -Compress))
            try { Assert-AgentsChatStoppedHandoffJsonBinding $document.RootElement $expected.RootElement }
            finally { $expected.Dispose() }
            $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @request
            $null = Assert-AgentsChatStoppedWorkerCleanup $Context
            if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
                throw 'Retired prepared observer changed during observation.'
            }
        }
    } finally {
        if ($document) { $document.Dispose() }
    }
}

function Get-AgentsChatStoppedHistoryHandoffRetiredPrepared(
    [hashtable]$Context, $Descriptor, [string]$AttemptId,
    [int]$ControllerPid, [string]$ControllerIdentity
) {
    try {
        $null = Assert-AgentsChatStoppedWorkerCleanup $Context
        Assert-AgentsChatCompletionGuid $AttemptId
        $name = "inactive-handoff-$AttemptId-prepared.json"
        Assert-AgentsChatRetirementDescriptor $Descriptor $name 1048576
        $held = Open-AgentsChatRetirementFile $Context $Descriptor $name
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($name)
        Assert-AgentsChatStoppedHistoryHandoffRetiredPreparedBinding $Context $held $AttemptId `
            $ControllerPid $ControllerIdentity
        Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($name)
        return [ordered]@{
            status='retired-prepared-handoff-observed'; attemptId=$AttemptId
            prepared=(Get-AgentsChatStoppedHandoffDescriptor $held $name 1048576)
            runtimeAuthority=$false; lockAuthority=$false
        }
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Retired prepared handoff observation failed; retain evidence.', $_.Exception)
    }
}
