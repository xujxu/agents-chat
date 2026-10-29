. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-restart-state-intent.ps1')

function Get-AgentsChatStoppedHistoryHandoffRestartStateText([hashtable]$Context) {
    Assert-AgentsChatStoppedHistoryHandoffRestartStateIntent $Context
    $document = [Text.Json.JsonDocument]::Parse($Context.HistoryHandoffRestartStateIntent.File.ReadText())
    try { $text = $document.RootElement.GetProperty('nextState').GetRawText() + "`n" }
    finally { $document.Dispose() }
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Restart next state is oversized.' }
    return $text
}

function Remove-AgentsChatStoppedHistoryHandoffRestartStateHandles([hashtable]$Context, $Identity) {
    foreach ($retained in @($Context.Files.ToArray())) {
        if ($retained -isnot [Deployment.WindowsPrivateFile]) { continue }
        $actual = $retained.CaptureIdentity()
        if ($actual.Dev -ceq $Identity.Dev -and $actual.Ino -ceq $Identity.Ino) {
            $retained.Dispose()
            $null = $Context.Files.Remove($retained)
        }
    }
}

function Write-AgentsChatStoppedHistoryHandoffRestartState(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity
) {
    if (-not $Context.ContainsKey('HistoryHandoffRestartStateWriter') -or
        $Context.HistoryHandoffRestartStateWriter -ne $true -or
        $Context.ContainsKey('HistoryHandoffRestartObserver')) {
        throw 'Restart state write requires its independent native role.'
    }
    try {
        if ($Context.Poisoned) { throw 'Restart state write scope is poisoned.' }
        if ($Context.ContainsKey('HistoryHandoffRestartState')) { throw 'Restart state already written.' }
        $observed = $Context.HistoryHandoffObservedCommit
        if ($ControllerPid -ne $observed.ControllerPid -or
            $ControllerIdentity -cne $observed.ControllerIdentity) {
            throw 'Restart state write controller differs.'
        }
        $stagePath = Join-Path $Context.Control 'state.json.lock'
        foreach ($pattern in @('state.json.lock', 'state.json.lock.pending-*')) {
            if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
                throw 'Restart state write found a competing stage.'
            }
        }
        $text = Get-AgentsChatStoppedHistoryHandoffRestartStateText $Context
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        $stage = [Deployment.WindowsPrivateFile]::Publish($stagePath, $text)
        $Context.Files.Add($stage)
        if ($stage.ReadText() -cne $text) { throw 'Restart state write stage differs.' }
        $Context.HistoryHandoffRestartStateStage = $stage
        $null = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Context $ControllerPid $ControllerIdentity
        if ((Get-AgentsChatStoppedHistoryHandoffRestartStateText $Context) -cne $text) {
            throw 'Restart state write intent changed.'
        }
        $original = $Context.HistoryHandoffRestartPrepared.Request
        $record = Get-AgentsChatStoppedHistoryHandoffRestartBinding -Context $Context @original
        $state = Open-AgentsChatRetirementFile $Context $record.state 'state.json'
        if ($state.ReadText() -cne $record.oldState) { throw 'Restart state write original state differs.' }
        $stage.Check()
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
        $staged = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json.lock', 'file')
        $before = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json', 'file')
        $null = $Context.Remove('HistoryHandoffRestartStateStage')
        Remove-AgentsChatStoppedHistoryHandoffRestartStateHandles $Context $stage.CaptureIdentity()
        Remove-AgentsChatStoppedHistoryHandoffRestartStateHandles $Context $state.CaptureIdentity()
        [Deployment.WindowsPrivateFile]::PublishSourceFile(
            $Context.Control, 'state.json', $staged, $before, $hash, $record.state.sha256)
        $written = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $hash
        $identity = $written.CaptureIdentity()
        if ($identity.Dev -cne $staged.Dev -or $identity.Ino -cne $staged.Ino -or $written.ReadText() -cne $text) {
            throw 'Restart state write replaced its acknowledged stage.'
        }
        foreach ($pattern in @('state.json.lock', 'state.json.lock.pending-*')) {
            if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
                throw 'Restart state write retained a stage.'
            }
        }
        $Context.HistoryHandoffRestartState = @{
            File=$written; Descriptor=(Get-AgentsChatStoppedHandoffDescriptor $written 'state.json')
        }
        return $Context.HistoryHandoffRestartState.Descriptor
    } catch {
        $Context.Poisoned = $true
        throw [InvalidOperationException]::new('Restart state write failed; retain evidence.', $_.Exception)
    }
}
