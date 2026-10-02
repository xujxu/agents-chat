function Read-AgentsChatTaskTransactionState([hashtable]$Transaction, [string]$ExpectedSha256) {
    if ((Get-Item -LiteralPath $Transaction.StateFile).Length -gt 65536) { throw 'Oversized transaction state.' }
    $digest = if ($ExpectedSha256) { $ExpectedSha256 } else {
        (Get-FileHash -LiteralPath $Transaction.StateFile -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $file = [Deployment.WindowsPrivateFile]::Open($Transaction.StateFile, $digest)
    try {
        $text = $file.ReadText()
        $fields = Read-AgentsChatMaintenanceFields $text @(
            'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase', 'sourceCommit',
            'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity', 'startedAt', 'updatedAt', 'errorCode')
        $state = @{ version=$fields.version.GetInt32() }
        foreach ($name in $fields.Keys) {
            if ($name -cne 'version') { $state[$name] = $fields[$name].GetString() }
        }
        if ($state.version -ne 1 -or $state.project -cne $Transaction.Project -or
            $state.operationId -cne $Transaction.OperationId -or $state.priorRuntime -cne 'running' -or
            $state.runtimeIdentity -cne $Transaction.Generation -or $state.startedAt -cne $Transaction.StartedAt -or
            $state.operation -cnotin @('deploy', 'update', 'restore') -or $null -ne $state.errorCode) {
            throw 'Transaction state identity differs.'
        }
        foreach ($name in @('sourceCommit', 'targetCommit')) {
            if ($null -ne $state[$name] -and $state[$name] -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') {
                throw 'Invalid transaction commit.'
            }
        }
        if ($null -ne $state.backupId -and $state.backupId -cnotmatch '^[a-zA-Z0-9_.:-]+$') {
            throw 'Invalid transaction backup.'
        }
        $started = [DateTimeOffset]::ParseExact($state.startedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $updated = [DateTimeOffset]::ParseExact($state.updatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($updated -lt $started) { throw 'Invalid transaction time.' }
        $file.Check()
        if ($ExpectedSha256) { $Transaction.InitialState = $text }
        return $state
    } finally { $file.Dispose() }
}

function Assert-AgentsChatTaskTransaction([hashtable]$Transaction) {
    if ($Transaction.Closed -or $Transaction.Poisoned) { throw 'Unavailable task transaction.' }
    try {
        if (Test-Path -LiteralPath (Join-Path $Transaction.Control 'recovery-lock')) { throw 'Recovery authority exists.' }
        $Transaction.Lock.Check()
        $Transaction.Configuration.Check()
        $state = Read-AgentsChatTaskTransactionState $Transaction ''
        $next = @{
            stopped=@('copying'); copying=@('rotating'); rotating=@('backup-ready')
            'backup-ready'=@('source-selected'); 'source-selected'=@('dependencies')
            dependencies=@('building'); building=@('configuring'); configuring=@('activating'); activating=@()
            restoring=@('restore-activating'); 'restore-activating'=@()
        }
        if ($state.operation -cne $Transaction.Operation -or
            -not $next.ContainsKey($state.phase) -or
            ($state.phase -ceq $Transaction.Phase -and $state.previousPhase -cne $Transaction.PreviousPhase) -or
            ($state.phase -cne $Transaction.Phase -and
                ($state.phase -cnotin $next[$Transaction.Phase] -or $state.previousPhase -cne $Transaction.Phase))) {
            throw 'Unsupported transaction phase change.'
        }
        $Transaction.Lock.Check()
        $Transaction.Configuration.Check()
        if (Test-Path -LiteralPath (Join-Path $Transaction.Control 'recovery-lock')) { throw 'Recovery authority exists.' }
        $Transaction.Phase = $state.phase
        $Transaction.PreviousPhase = $state.previousPhase
    } catch {
        $Transaction.Poisoned = $true
        throw
    }
}

function Close-AgentsChatTaskTransaction([hashtable]$Transaction) {
    if ($Transaction.Closed) { return }
    $Transaction.Closed = $true
    try { if ($Transaction.Configuration) { $Transaction.Configuration.Dispose() } }
    finally { if ($Transaction.Lock) { $Transaction.Lock.Dispose() } }
}

function Write-AgentsChatTaskTransactionEvidence([hashtable]$Context) {
    $transaction = $Context.Transaction
    Assert-AgentsChatTaskTransaction $transaction
    $record = [ordered]@{
        version=1; operationId=$transaction.OperationId; project=$transaction.Project
        controllerIdentity=$Context.Data.controllerIdentity; admissionSha256=$Context.AdmissionSha256
        lockSha256=$transaction.Lock.Sha256; initialStateSha256=$transaction.InitialStateSha256
        initialState=$transaction.InitialState
        priorRuntime='running'; runtimeIdentity=$transaction.Generation
    }
    return [Deployment.WindowsPrivateFile]::Publish(
        (Join-Path $Context.Directory 'transaction.json'), ($record | ConvertTo-Json -Compress))
}

function Open-AgentsChatTaskTransaction {
    param([string]$Control, [string]$LockSha256, [string]$StateSha256, [hashtable]$AdmissionFields)
    $transaction = @{
        Lock=$null; Configuration=$null; Closed=$false; Poisoned=$false
        Project=$null; OperationId=$null; Generation=$null; StartedAt=$null
        StateFile=(Join-Path $Control 'state.json'); Phase=$null; PreviousPhase=$null; Operation=$null
        InitialStateSha256=$StateSha256; ReceiptSha256=$null
        InitialState=$null; Control=$Control
    }
    try {
        $transaction.Lock = [Deployment.WindowsPrivateFile]::Open((Join-Path $Control 'lock/owner.json'), $LockSha256)
        $fields = Read-AgentsChatMaintenanceFields ($transaction.Lock.ReadText()) @(
            'version', 'token', 'project', 'operationId', 'pid', 'processIdentity', 'createdAt')
        $token = $fields.token.GetString()
        if ($fields.version.GetInt32() -ne 1 -or ([guid]$token).ToString('D') -cne $token -or
            [guid]$token -eq [guid]::Empty -or $fields.pid.GetInt32() -ne $AdmissionFields.controllerPid.GetInt32() -or
            $fields.processIdentity.GetString() -cne $AdmissionFields.controllerIdentity.GetString() -or
            $fields.operationId.GetString() -cne $AdmissionFields.operationId.GetString()) {
            throw 'Original transaction lock differs.'
        }
        $transaction.Project = $fields.project.GetString()
        $project = $transaction.Project
        if ($project -cnotmatch '^[A-Za-z]:\\' -or
            [IO.Path]::GetFullPath($project) -ine $project -or
            [string]::Equals($project, $Control, [StringComparison]::OrdinalIgnoreCase) -or
            $Control.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $project.StartsWith($Control.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Transaction control must be external to its project.'
        }
        $transaction.OperationId = $fields.operationId.GetString()
        $transaction.Generation = $AdmissionFields.generation.GetString()
        $transaction.StartedAt = $fields.createdAt.GetString()
        $transaction.Configuration = [Deployment.WindowsPrivateFile]::Open(
            $AdmissionFields.configuration.GetString(), $AdmissionFields.configurationSha256.GetString())
        $configuration = [Text.Json.JsonDocument]::Parse($transaction.Configuration.ReadText())
        try {
            if ($configuration.RootElement.GetProperty('command').GetProperty('cwd').GetString() -cne $project) {
                throw 'Managed command does not use the locked project.'
            }
        } finally { $configuration.Dispose() }
        $state = Read-AgentsChatTaskTransactionState $transaction $StateSha256
        $phase = if ($state.operation -ceq 'restore') { 'restoring' } else { 'stopped' }
        $previous = if ($state.operation -ceq 'restore') { 'restore-preflight' } else { 'preflight' }
        if ($state.phase -cne $phase -or $state.previousPhase -cne $previous) {
            throw 'Native stop requires stopped-phase transaction admission.'
        }
        $transaction.Operation = $state.operation
        $transaction.Phase = $state.phase
        $transaction.PreviousPhase = $state.previousPhase
        Assert-AgentsChatTaskTransaction $transaction
        return $transaction
    } catch {
        Close-AgentsChatTaskTransaction $transaction
        throw
    }
}
