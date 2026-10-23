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
