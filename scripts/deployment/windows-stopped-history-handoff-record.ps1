. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-owner.ps1')

function Get-AgentsChatStoppedHandoffDescriptor($File, [string]$Name, [int]$MaximumBytes = 65536) {
    $File.Check()
    $identity = $File.CaptureIdentity()
    $descriptor = [ordered]@{
        path=$Name; dev=$identity.Dev; ino=$identity.Ino
        bytes=$File.ByteLength; sha256=$File.Sha256
    }
    Assert-AgentsChatRetirementDescriptor $descriptor $Name $MaximumBytes
    return $descriptor
}

function Get-AgentsChatStoppedHistoryHandoffBinding(
    [hashtable]$Context, [string]$AttemptId, $Owner
) {
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    $intentName = "retired-$($Context.OperationId)-inactive-rollback-history-intent.json"
    $completionName = "retired-$($Context.OperationId)-inactive-rollback-history-complete.json"
    if (-not $Context.ContainsKey('HistoryCompletion') -or
        $Context.HistoryIntentPath -cne (Join-Path $Context.Control $intentName)) {
        throw 'Native handoff preparation requires completed original archival.'
    }
    $state = Open-AgentsChatRetirementFile $Context $Context.TaskRecord.checkpoint.state 'state.json'
    $oldState = $state.ReadText()
    $task = $Context.Folder.GetTask($Context.TaskName)
    $user = [string]$task.Definition.Principal.UserId
    $sid = if ($user -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($user) }
        else { ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]) }
    $configuration = $Context.Admission.configuration.GetString()
    if ($Context.ContainsKey('RuntimeHandoffReleased')) {
        $configuration = Join-Path $Context.RuntimeHandoffDirectory 'configuration.json'
    }
    $record = [ordered]@{
        version=1; phase='stopped-history-handoff-prepared'; attemptId=$AttemptId
        control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId; operation='update'; oldState=$oldState
        state=(Get-AgentsChatStoppedHandoffDescriptor $state 'state.json')
        intent=(Get-AgentsChatStoppedHandoffDescriptor $Context.HistoryIntent $intentName)
        completion=(Get-AgentsChatStoppedHandoffDescriptor $Context.HistoryCompletion $completionName)
        newOwner=$Owner
        observation=[ordered]@{
            status='inactive-task-observed'; runtimeAuthority=$false
            project=$Context.Project; taskName=$Context.TaskName; definition=$Context.Definition
            securityDescriptor=$Context.SecurityDescriptor; principalSid=$sid.Value; enabled=$false
            configuration=$configuration; configurationSha256=$Context.RetiredRuntime.configurationSha256
            runtime=$null; retiredRuntime=$Context.RetiredRuntime
        }
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 12 -Compress)) -gt 1048576) {
        throw 'Native prepared handoff response is oversized.'
    }
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    return $record
}

function Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt([hashtable]$Context) {
    $state = Open-AgentsChatRetirementFile $Context $Context.TaskRecord.checkpoint.state 'state.json'
    $document = [Text.Json.JsonDocument]::Parse($state.ReadText())
    try { return $document.RootElement.GetProperty('updatedAt').GetString() }
    finally { $document.Dispose() }
}

function Get-AgentsChatStoppedHistoryHandoffPreparedRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-handoff-*') { throw 'Existing handoff requires explicit settlement.' }
    }
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $Context)
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
    $record = Get-AgentsChatStoppedHistoryHandoffBinding $Context $AttemptId $owner
    $null = New-AgentsChatStoppedHistoryHandoffOwner @request
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-handoff-*') { throw 'Handoff appeared during native preparation.' }
    }
    return $record
}
