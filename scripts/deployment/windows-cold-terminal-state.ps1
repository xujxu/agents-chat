function Get-AgentsChatColdTerminalHash([string]$Text) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function Read-AgentsChatColdTerminalSource([hashtable]$Context, $StateFile) {
    $marker = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'cold-restore-terminal.json') $Context.TerminalSha256
    if ($marker.ByteLength -gt 1048576) { throw 'Oversized cold terminal handoff.' }
    $record = Read-AgentsChatMaintenanceFields ($marker.ReadText()) @(Get-AgentsChatColdTerminalFields)
    $files = Read-AgentsChatMaintenanceFields $record.files.GetRawText() @('state', 'lock', 'transaction')
    $original = Read-AgentsChatMaintenanceFields $files.state.GetRawText() @('dev', 'ino', 'bytes', 'sha256')
    $text = $record.oldState.GetString()
    $next = $record.nextState.GetString()
    $hash = Get-AgentsChatColdTerminalHash $text
    $bytes = [Text.Encoding]::UTF8.GetByteCount($text)
    if ($bytes -lt 1 -or $bytes -gt 65536 -or [Text.Encoding]::UTF8.GetByteCount($next) -gt 65536 -or
        $hash -cne $record.stateSha256.GetString() -or $hash -cne $original.sha256.GetString() -or
        $bytes -ne $original.bytes.GetInt32() -or $original.dev.GetString() -cnotmatch '^[0-9]+$' -or
        $original.ino.GetString() -cnotmatch '^[0-9]+$') { throw 'Cold terminal original state binding differs.' }
    $Context.TerminalRecord = $record
    $Context.TerminalStateFile = $StateFile
    $Context.TerminalOriginalState = [ordered]@{
        dev=$original.dev.GetString(); ino=$original.ino.GetString(); bytes=$bytes; sha256=$hash
    }
    Assert-AgentsChatColdTerminalPhysicalState $Context
    return @{ Text=$text; Sha256=$hash }
}

function Assert-AgentsChatColdTerminalPhysicalState([hashtable]$Context) {
    $file = $Context.TerminalStateFile
    $file.Check()
    $text = $file.ReadText()
    $Context.TerminalPublished = $text -ceq $Context.TerminalRecord.nextState.GetString()
    if (-not $Context.TerminalPublished) {
        $original = $Context.TerminalOriginalState
        $actual = Get-AgentsChatColdTerminalFile $file
        if ($text -cne $Context.TerminalRecord.oldState.GetString() -or
            $actual.dev -cne $original.dev -or $actual.ino -cne $original.ino -or
            $actual.bytes -ne $original.bytes -or $actual.sha256 -cne $original.sha256) {
            throw 'Cold terminal physical state differs from both admitted states.'
        }
    }
    foreach ($pattern in @('state.json.lock.pending-*', 'cold-restore-terminal.json.pending-*')) {
        if ([IO.Directory]::GetFileSystemEntries($Context.Control, $pattern).Length) {
            throw 'Incomplete cold terminal publication requires inspection.'
        }
    }
    if ($Context.TerminalPublished -and (Test-Path -LiteralPath (Join-Path $Context.Control 'state.json.lock'))) {
        throw 'Published cold terminal state retains competing staged evidence.'
    }
}

function Release-AgentsChatColdTerminalFile([hashtable]$Context, $File) {
    $identity = $File.CaptureIdentity()
    foreach ($retained in @($Context.Files.ToArray())) {
        if ($retained -isnot [Deployment.WindowsPrivateFile]) { continue }
        $actual = $retained.CaptureIdentity()
        if ($actual.Dev -ceq $identity.Dev -and $actual.Ino -ceq $identity.Ino) {
            $retained.Dispose()
            $null = $Context.Files.Remove($retained)
        }
    }
}

function Publish-AgentsChatColdTerminalState {
    param([hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity, [switch]$Publish)
    $null = Prepare-AgentsChatColdTerminalRestore $Context $ControllerPid $ControllerIdentity -Consume
    Assert-AgentsChatColdTerminalPhysicalState $Context
    $nextText = $Context.TerminalRecord.nextState.GetString()
    $nextHash = Get-AgentsChatColdTerminalHash $nextText
    if (-not $Context.TerminalPublished) {
        $stagePath = Join-Path $Context.Control 'state.json.lock'
        if (Test-Path -LiteralPath $stagePath) {
            $stage = Open-AgentsChatCompletionFile $Context $stagePath $nextHash
        } elseif ($Publish) {
            throw 'Cold terminal publication requires its acknowledged stage.'
        } else {
            $stage = [Deployment.WindowsPrivateFile]::Publish($stagePath, $nextText)
            $Context.Files.Add($stage)
        }
        if ($stage.ReadText() -cne $nextText) { throw 'Cold terminal staged state differs.' }
        if ($Publish) {
            $null = Assert-AgentsChatColdCompletionProof $Context
            $staged = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json.lock', 'file')
            $before = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json', 'file')
            Release-AgentsChatColdTerminalFile $Context $stage
            Release-AgentsChatColdTerminalFile $Context $Context.TerminalStateFile
            [Deployment.WindowsPrivateFile]::PublishSourceFile(
                $Context.Control, 'state.json', $staged, $before, $nextHash, $Context.StateSha256)
            $Context.TerminalStateFile = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $nextHash
            $identity = $Context.TerminalStateFile.CaptureIdentity()
            if ($identity.Dev -cne $staged.Dev -or $identity.Ino -cne $staged.Ino) {
                throw 'Cold terminal publication replaced its original staged inode.'
            }
        }
    }
    Assert-AgentsChatColdTerminalPhysicalState $Context
    $null = Assert-AgentsChatColdCompletionProof $Context
    return [ordered]@{
        status=$(if ($Context.TerminalPublished) { 'cold-terminal-state-published' } else { 'cold-terminal-state-staged' })
        operationId=$Context.OperationId; terminalSha256=$Context.TerminalSha256; stateSha256=$nextHash
    }
}
