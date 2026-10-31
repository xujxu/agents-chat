. (Join-Path $PSScriptRoot 'windows-cold-terminal-state.ps1')

function Read-AgentsChatInactiveRollbackSource([hashtable]$Context, [string]$ExpectedHash) {
    $terminal = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'inactive-rollback-terminal.json') ''
    if ($terminal.ByteLength -gt 1048576) { throw 'Oversized stopped terminal handoff.' }
    $record = Read-AgentsChatMaintenanceFields ($terminal.ReadText()) @(
        'version', 'phase', 'project', 'operationId', 'taskName', 'stateSha256', 'oldState', 'sourceCommit',
        'priorRuntime', 'restoredRuntime', 'rollbackIntentSha256', 'filesReceiptSha256',
        'taskIntentSha256', 'taskReceiptSha256', 'runtimeBundle', 'stateIdentity')
    $text = $record.oldState.GetString()
    $identity = Read-AgentsChatMaintenanceFields $record.stateIdentity.GetRawText() @('dev', 'ino', 'bytes')
    if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536 -or
        (Get-AgentsChatColdTerminalHash $text) -cne $ExpectedHash -or
        $record.stateSha256.GetString() -cne $ExpectedHash -or
        $identity.bytes.GetInt32() -ne [Text.Encoding]::UTF8.GetByteCount($text) -or
        $identity.dev.GetString() -cnotmatch '^[0-9]+$' -or $identity.ino.GetString() -cnotmatch '^[0-9]+$') {
        throw 'Stopped terminal original state binding differs.'
    }
    $Context.RollbackOriginalState = $text
    $Context.RollbackOriginalIdentity = @{
        Dev=$identity.dev.GetString(); Ino=$identity.ino.GetString(); Bytes=$identity.bytes.GetInt32()
    }
    $Context.RollbackPhysicalState = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') ''
    $Context.RollbackPublished = $Context.RollbackPhysicalState.ReadText() -cne $text
    if ($Context.RollbackPublished) {
        $intent = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'inactive-rollback-state-intent.json') ''
        if ($intent.ByteLength -gt 262144) { throw 'Oversized stopped state intent.' }
        $fields = Read-AgentsChatMaintenanceFields ($intent.ReadText()) @(
            'version', 'phase', 'operationId', 'terminalSha256', 'oldState', 'nextState')
        $next = [Text.Json.JsonDocument]::Parse($fields.nextState.GetString())
        try {
            $expected = Get-AgentsChatInactiveRollbackNextState $text $next.RootElement.GetProperty('updatedAt').GetString()
        } finally { $next.Dispose() }
        if ($fields.version.GetInt32() -ne 1 -or $fields.phase.GetString() -cne 'state-prepared' -or
            $fields.operationId.GetString() -cne $Context.OperationId -or
            $fields.terminalSha256.GetString() -cne $terminal.Sha256 -or
            $fields.oldState.GetString() -cne $text -or $fields.nextState.GetString() -cne $expected -or
            $Context.RollbackPhysicalState.ReadText() -cne $expected) {
            throw 'Published stopped state differs from its original handoff.'
        }
        $Context.RollbackNextState = $expected
    }
    Assert-AgentsChatInactiveRollbackPhysicalState $Context
    return $text
}

function Assert-AgentsChatInactiveRollbackPhysicalState([hashtable]$Context) {
    $file = $Context.RollbackPhysicalState
    $file.Check()
    if ($Context.RollbackPublished) {
        if ($file.ReadText() -cne $Context.RollbackNextState -or
            (Test-Path -LiteralPath (Join-Path $Context.Control 'state.json.lock'))) {
            throw 'Published stopped state differs or retains competing staging.'
        }
    } else {
        $actual = $file.CaptureIdentity()
        $original = $Context.RollbackOriginalIdentity
        if ($file.ReadText() -cne $Context.RollbackOriginalState -or
            $actual.Dev -cne $original.Dev -or $actual.Ino -cne $original.Ino -or
            $file.ByteLength -ne $original.Bytes) { throw 'Original stopped state identity changed.' }
    }
    if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'state.json.lock.pending-*').Length) {
        throw 'Incomplete stopped state staging requires inspection.'
    }
}

function Get-AgentsChatInactiveRollbackNextState([string]$OldState, [string]$UpdatedAt) {
    $format = 'yyyy-MM-ddTHH:mm:ss.fffZ'
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $updated = [DateTimeOffset]::ParseExact($UpdatedAt, $format, $culture, $style)
    $document = [Text.Json.JsonDocument]::Parse($OldState)
    try {
        $old = $document.RootElement
        if ($old.GetProperty('phase').GetString() -cne 'accepted' -or
            $old.GetProperty('operation').GetString() -cne 'update' -or
            $old.GetProperty('priorRuntime').GetString() -cne 'stopped' -or
            $updated -lt [DateTimeOffset]::ParseExact($old.GetProperty('updatedAt').GetString(), $format, $culture, $style)) {
            throw 'Stopped rollback state requires original accepted update and non-backdated timestamp.'
        }
        $properties = [Collections.Generic.List[string]]::new()
        foreach ($property in $old.EnumerateObject()) {
            $value = switch -CaseSensitive ($property.Name) {
                'phase' { '"restored"' }
                'previousPhase' { '"accepted"' }
                'updatedAt' { '"' + $UpdatedAt + '"' }
                default { $property.Value.GetRawText() }
            }
            $properties.Add('"' + $property.Name + '":' + $value)
        }
        return '{' + ($properties -join ',') + '}'
    } finally { $document.Dispose() }
}

function Stage-AgentsChatInactiveRollbackState([hashtable]$Context, [switch]$InspectOnly) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ContainsKey('ExclusiveLostRuntime') -or -not $Context.ExclusiveLostRuntime -or
        -not $Context.ContainsKey('RollbackTerminal') -or -not $Context.RollbackTaskComplete) {
        throw 'Stopped terminal state requires exclusive completed rollback handoff.'
    }
    $intentPath = Join-Path $Context.Control 'inactive-rollback-state-intent.json'
    $stagePath = Join-Path $Context.Control 'state.json.lock'
    if (-not $Context.ContainsKey('RollbackStateIntent')) {
        $terminal = $Context.RollbackTerminal.ReadText() | ConvertFrom-Json
        $existing = Test-Path -LiteralPath $intentPath
        if (-not $existing -and ($InspectOnly -or (Test-Path -LiteralPath $stagePath))) {
            throw 'Stopped terminal state has no original staging intent.'
        }
        $updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        if ($existing) {
            $intent = Open-AgentsChatCompletionFile $Context $intentPath ''
            $stored = Read-AgentsChatMaintenanceFields ($intent.ReadText()) @(
                'version', 'phase', 'operationId', 'terminalSha256', 'oldState', 'nextState')
            $next = [Text.Json.JsonDocument]::Parse($stored.nextState.GetString())
            try { $updatedAt = $next.RootElement.GetProperty('updatedAt').GetString() }
            finally { $next.Dispose() }
        }
        $nextState = Get-AgentsChatInactiveRollbackNextState $terminal.oldState $updatedAt
        $record = [ordered]@{
            version=1; phase='state-prepared'; operationId=$Context.OperationId
            terminalSha256=$Context.RollbackTerminal.Sha256
            oldState=$terminal.oldState; nextState=$nextState
        }
        $text = $record | ConvertTo-Json -Depth 4 -Compress
        if ($existing) {
            if ($intent.ReadText() -cne $text) { throw 'Stopped state proposal differs from original terminal handoff.' }
        } else {
            $intent = [Deployment.WindowsPrivateFile]::Publish($intentPath, $text)
            $Context.Files.Add($intent)
        }
        $Context.RollbackStateIntent = $intent
        $Context.RollbackNextState = $nextState
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if ($Context.RollbackPublished) {
        if (-not $InspectOnly) { throw 'Stopped terminal state is already published.' }
        return
    }
    if (-not $Context.ContainsKey('RollbackStagedState')) {
        if (Test-Path -LiteralPath $stagePath) {
            $staged = Open-AgentsChatCompletionFile $Context $stagePath ''
            if ($staged.ReadText() -cne $Context.RollbackNextState) { throw 'Foreign stopped rollback staged state.' }
        } elseif ($InspectOnly) {
            return
        } else {
            $staged = [Deployment.WindowsPrivateFile]::Publish($stagePath, $Context.RollbackNextState)
            $Context.Files.Add($staged)
        }
        $Context.RollbackStagedState = $staged
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{
        status='inactive-terminal-state-staged'; file=$stagePath; sha256=$Context.RollbackStagedState.Sha256
    }
}

function Publish-AgentsChatInactiveRollbackState([hashtable]$Context) {
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    if (-not $Context.ExclusiveLostRuntime -or -not $Context.ContainsKey('RollbackStateIntent') -or
        -not $Context.ContainsKey('RollbackTerminal') -or -not $Context.RollbackTaskComplete) {
        throw 'Stopped state publication requires acknowledged staging and completed rollback.'
    }
    $hash = Get-AgentsChatColdTerminalHash $Context.RollbackNextState
    if (-not $Context.RollbackPublished) {
        if (-not $Context.ContainsKey('RollbackStagedState')) { throw 'Stopped state has no acknowledged stage.' }
        $Context.RollbackStagedState.Check()
        $staged = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json.lock', 'file')
        $before = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Context.Control, 'state.json', 'file')
        Release-AgentsChatColdTerminalFile $Context $Context.RollbackStagedState
        Release-AgentsChatColdTerminalFile $Context $Context.RollbackPhysicalState
        $Context.Remove('RollbackStagedState')
        [Deployment.WindowsPrivateFile]::PublishSourceFile(
            $Context.Control, 'state.json', $staged, $before, $hash, $Context.StateSha256)
        $Context.RollbackPhysicalState = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $hash
        $identity = $Context.RollbackPhysicalState.CaptureIdentity()
        if ($identity.Dev -cne $staged.Dev -or $identity.Ino -cne $staged.Ino) {
            throw 'Stopped state publication changed the acknowledged staged inode.'
        }
        $Context.RollbackPublished = $true
    }
    $null = Assert-AgentsChatInactiveLostRuntimeEvidence $Context
    return [pscustomobject]@{
        status='inactive-terminal-state-published'; file=(Join-Path $Context.Control 'state.json'); sha256=$hash
    }
}
