function Initialize-AgentsChatStoppedHistoryStateTransition([hashtable]$Context, $Request) {
    if ($Context.ContainsKey('HistoryStateTransition') -or $Context.ContainsKey('HistoryWriter') -or
        $Request -isnot [Collections.IDictionary]) {
        throw 'Stopped history state transition bootstrap differs.'
    }
    $first = $Request.Contains('stateIntent') -or $Request.Contains('state')
    $fields = if ($first) { @('stateIntent', 'state') } else { @('restart', 'restartCommitted', 'restartStateIntent', 'restartState') }
    foreach ($field in $fields) {
        if (-not $Request.Contains($field)) { throw 'Stopped history state transition requires its committed handoff.' }
    }
    if ($first -and ($Request.Contains('restartStateIntent') -or $Request.Contains('restartState'))) {
        throw 'Stopped history state transition mixes first-attempt and restart writes.'
    }
    $phase = if ($first) { 'stopped-history-handoff-state-intent' } else { 'stopped-history-handoff-restart-state-intent' }
    $intentDescriptor = if ($first) { $Request.stateIntent } else { $Request.restartStateIntent }
    $writtenDescriptor = if ($first) { $Request.state } else { $Request.restartState }
    Assert-AgentsChatRetirementFields $intentDescriptor @('path', 'dev', 'ino', 'bytes', 'sha256')
    if ($intentDescriptor.path -isnot [string] -or
        $intentDescriptor.path -cnotmatch '^inactive-handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-state-intent\.json$') {
        throw 'Stopped history state transition intent name differs.'
    }
    Assert-AgentsChatRetirementDescriptor $intentDescriptor $intentDescriptor.path 1048576
    $intent = Open-AgentsChatRetirementFile $Context $intentDescriptor $intentDescriptor.path
    $document = [Text.Json.JsonDocument]::Parse($intent.ReadText())
    try {
        $root = $document.RootElement
        $attemptId = $root.GetProperty('attemptId').GetString()
        Assert-AgentsChatCompletionGuid $attemptId
        if ($root.GetProperty('phase').GetString() -cne $phase -or
            $intentDescriptor.path -cne "inactive-handoff-$attemptId-state-intent.json" -or
            $root.GetProperty('oldState').ValueKind -ne [Text.Json.JsonValueKind]::String -or
            $root.GetProperty('nextState').ValueKind -ne [Text.Json.JsonValueKind]::Object) {
            throw 'Stopped history state transition intent differs.'
        }
        $oldState = $root.GetProperty('oldState').GetString()
        $nextText = $root.GetProperty('nextState').GetRawText() + "`n"
        $original = Read-AgentsChatRetirementJson $root.GetProperty('state').GetRawText()
    } finally { $document.Dispose() }
    Assert-AgentsChatRetirementDescriptor $original 'state.json'
    if ([Text.Encoding]::UTF8.GetByteCount($oldState) -ne $original.bytes -or
        (Get-AgentsChatColdTerminalHash $oldState) -cne $original.sha256) {
        throw 'Stopped history state transition original state differs.'
    }
    Assert-AgentsChatRetirementDescriptor $writtenDescriptor 'state.json'
    if ($writtenDescriptor.dev -ceq $original.dev -and $writtenDescriptor.ino -ceq $original.ino) {
        throw 'Stopped history state transition did not replace its original state.'
    }
    $written = Open-AgentsChatRetirementFile $Context $writtenDescriptor 'state.json'
    if ($written.ReadText() -cne $nextText) { throw 'Stopped history state transition written state differs.' }
    $snapshot = [pscustomobject]@{
        Sha256=$original.sha256; ByteLength=[int]$original.bytes
        Dev=$original.dev; Ino=$original.ino; Text=$oldState; Written=$written
    }
    $snapshot | Add-Member -MemberType ScriptMethod -Name Check -Value { $this.Written.Check() }
    $snapshot | Add-Member -MemberType ScriptMethod -Name ReadText -Value { $this.Written.Check(); return $this.Text }
    $snapshot | Add-Member -MemberType ScriptMethod -Name CaptureIdentity -Value {
        return [pscustomobject]@{ Dev=$this.Dev; Ino=$this.Ino }
    }
    $snapshot | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    $Context.HistoryStateTransition = @{
        AttemptId=$attemptId; Original=$original; OldState=$oldState; NextText=$nextText
        Intent=$intent; IntentDescriptor=$intentDescriptor; Written=$written; WrittenDescriptor=$writtenDescriptor
        FirstAttempt=$first
        Snapshot=$snapshot
    }
    Assert-AgentsChatStoppedHistoryStateTransition $Context
}

function Assert-AgentsChatStoppedHistoryStateTransition([hashtable]$Context) {
    $transition = $Context.HistoryStateTransition
    $transition.Intent.Check()
    if ($transition.Written.ReadText() -cne $transition.NextText) {
        throw 'Stopped history state transition written state changed.'
    }
    $identity = $transition.Written.CaptureIdentity()
    if ($identity.Dev -cne $transition.WrittenDescriptor.dev -or $identity.Ino -cne $transition.WrittenDescriptor.ino) {
        throw 'Stopped history state transition written state was replaced.'
    }
}

function Open-AgentsChatStoppedHistoryState([hashtable]$Context, $Descriptor) {
    if (-not $Context.ContainsKey('HistoryStateTransition')) {
        if ($null -eq $Descriptor) {
            return Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') ''
        }
        return Open-AgentsChatRetirementFile $Context $Descriptor 'state.json'
    }
    $transition = $Context.HistoryStateTransition
    if ($null -ne $Descriptor) {
        Assert-AgentsChatRetirementDescriptor $Descriptor 'state.json'
        foreach ($field in @('path', 'dev', 'ino', 'bytes', 'sha256')) {
            if ($Descriptor[$field] -cne $transition.Original[$field]) {
                throw 'Stopped history original state differs from its restart transition.'
            }
        }
    }
    Assert-AgentsChatStoppedHistoryStateTransition $Context
    return $transition.Snapshot
}
