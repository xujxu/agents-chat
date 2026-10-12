function Get-AgentsChatColdTerminalFile($File) {
    $identity = $File.CaptureIdentity()
    return [ordered]@{ dev=$identity.Dev; ino=$identity.Ino; bytes=$File.ByteLength; sha256=$File.Sha256 }
}

function Get-AgentsChatColdTerminalDirectory([hashtable]$Context, [string]$Path) {
    $held = [Deployment.WindowsPrivateFile]::OpenDirectory($Path)
    $Context.Files.Add($held)
    $identity = $held.CaptureIdentity()
    return [ordered]@{ dev=$identity.Dev; ino=$identity.Ino }
}

function Get-AgentsChatColdTerminalState([hashtable]$Context, [string]$UpdatedAt, [string]$OldState) {
    $format = 'yyyy-MM-ddTHH:mm:ss.fffZ'
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $updated = [DateTimeOffset]::ParseExact($UpdatedAt, $format, $culture, $style)
    $old = Read-AgentsChatMaintenanceFields $OldState ([string[]]@($Context.InitialState.Keys))
    foreach ($prior in @($old.updatedAt.GetString(), $Context.ColdActivationState.updatedAt.GetString())) {
        if ($updated -lt [DateTimeOffset]::ParseExact($prior, $format, $culture, $style)) {
            throw 'Cold terminal state cannot predate its original evidence.'
        }
    }
    $properties = [Collections.Generic.List[string]]::new()
    foreach ($name in @($Context.ColdActivationState.Keys | Sort-Object)) {
        $value = switch -CaseSensitive ($name) {
            'phase' { '"restored"' }
            'previousPhase' { '"restore-activating"' }
            'updatedAt' { '"' + $UpdatedAt + '"' }
            default { $Context.ColdActivationState[$name].GetRawText() }
        }
        $properties.Add('"' + $name + '":' + $value)
    }
    return '{' + ($properties -join ',') + '}'
}

function Prepare-AgentsChatColdTerminalRestore {
    param([hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity)
    $null = Assert-AgentsChatColdCompletionProof $Context
    if (-not $Context.CompletionRecovery -or $Context.Phase -cne 'complete' -or $Context.Step -cne 'complete') {
        throw 'Cold terminal handoff requires completed runtime policy.'
    }
    Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original cold terminal controller changed.'
    }
    $path = Join-Path $Context.Control 'cold-restore-terminal.json'
    if ([IO.Directory]::GetFileSystemEntries($Context.Control, 'cold-restore-terminal.json.pending-*').Length) {
        throw 'Incomplete cold terminal publication evidence requires inspection.'
    }
    $fields = @('version', 'phase', 'project', 'operationId', 'taskName', 'stateSha256', 'ownerSha256',
        'filesReceiptSha256', 'intentSha256', 'historySha256', 'completionSha256', 'runtime', 'port', 'providers',
        'oldState', 'nextState', 'rootIdentity', 'lockIdentity', 'recoveryIdentity', 'files', 'creator')
    $existing = $stored = $null
    $updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    if (Test-Path -LiteralPath $path) {
        $existing = Open-AgentsChatCompletionFile $Context $path ''
        $stored = Read-AgentsChatMaintenanceFields ($existing.ReadText()) $fields
        $next = Read-AgentsChatMaintenanceFields $stored.nextState.GetString() ([string[]]@($Context.InitialState.Keys))
        $updatedAt = $next.updatedAt.GetString()
        $creator = Read-AgentsChatMaintenanceFields $stored.creator.GetRawText() @(
            'pid', 'processIdentity', 'bridgePid', 'bridgeIdentity')
        Assert-AgentsChatCompletionProcessIdentity $creator.pid.GetInt32() $creator.processIdentity.GetString()
        Assert-AgentsChatCompletionProcessIdentity $creator.bridgePid.GetInt32() $creator.bridgeIdentity.GetString()
        if ($creator.pid.GetInt32() -eq $creator.bridgePid.GetInt32()) { throw 'Ambiguous cold terminal creator.' }
        if ($creator.pid.GetInt32() -ne $ControllerPid -or $creator.processIdentity.GetString() -cne $ControllerIdentity) {
            Assert-AgentsChatCompletionProcessAbsent $creator.pid.GetInt32() $creator.processIdentity.GetString()
        }
        if ($creator.bridgePid.GetInt32() -ne $PID -or
            $creator.bridgeIdentity.GetString() -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
            Assert-AgentsChatCompletionProcessAbsent $creator.bridgePid.GetInt32() $creator.bridgeIdentity.GetString()
        }
    }
    $state = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'state.json') $Context.StateSha256
    $lock = Open-AgentsChatCompletionFile $Context (Join-Path $Context.Control 'lock/owner.json') ''
    $runtime = [ordered]@{}
    foreach ($name in @('pid', 'identity', 'generation', 'instanceGuid', 'sessionId',
        'configurationSha256', 'launcherPid', 'readySha256')) { $runtime[$name] = $Context.Runtime[$name] }
    $candidate = [ordered]@{
        version=1; phase='prepared'; project=$Context.Project; operationId=$Context.OperationId
        taskName=$Context.TaskName; stateSha256=$Context.StateSha256
        ownerSha256=$Context.ColdOwnerSha256; filesReceiptSha256=$Context.ColdReceiptSha256
        intentSha256=$Context.ColdIntentSha256; historySha256=$Context.ColdHistorySha256
        completionSha256=$Context.CompletionSha256; runtime=$runtime; port=$Context.Port; providers=$Context.Providers
        oldState=$state.ReadText(); nextState=(Get-AgentsChatColdTerminalState $Context $updatedAt ($state.ReadText()))
        rootIdentity=(Get-AgentsChatColdTerminalDirectory $Context $Context.Control)
        lockIdentity=(Get-AgentsChatColdTerminalDirectory $Context (Join-Path $Context.Control 'lock'))
        recoveryIdentity=(Get-AgentsChatColdTerminalDirectory $Context (Join-Path $Context.Control 'recovery-lock'))
        files=[ordered]@{
            state=(Get-AgentsChatColdTerminalFile $state); lock=(Get-AgentsChatColdTerminalFile $lock)
            transaction=(Get-AgentsChatColdTerminalFile $Context.CompletionAuthority)
        }
        creator=[ordered]@{
            pid=$ControllerPid; processIdentity=$ControllerIdentity
            bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        }
    }
    $text = $candidate | ConvertTo-Json -Depth 6 -Compress
    if ($stored) {
        $expected = Read-AgentsChatMaintenanceFields $text $fields
        foreach ($name in $fields) {
            if ($name -cne 'creator' -and $stored[$name].GetRawText() -cne $expected[$name].GetRawText()) {
                throw "Cold terminal handoff changed its original binding: $name."
            }
        }
    } else {
        $null = Assert-AgentsChatColdCompletionProof $Context
        $existing = [Deployment.WindowsPrivateFile]::Publish($path, $text)
        $Context.Files.Add($existing)
    }
    $null = Assert-AgentsChatColdCompletionProof $Context
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Cold terminal controller changed during handoff.'
    }
    return [ordered]@{ status='cold-terminal-prepared'; operationId=$Context.OperationId; sha256=$existing.Sha256 }
}
