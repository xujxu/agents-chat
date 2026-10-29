param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$Request,
    [switch]$Hold
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $failure = $null
try {
    Add-Type -Path @(
        'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
        'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
        ForEach-Object { Join-Path $Source $_ })
    . (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
    . (Join-Path $Source 'windows-stopped-history-handoff-successor-abandoned-observation.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $inputRecord = Read-AgentsChatRetirementJson $Request
    $fields = @(
        'attemptId', 'prepared', 'committed', 'retirement', 'terminal', 'successor', 'successorAbandoned', 'restart'
    )
    $observeCommitted = $inputRecord -is [Collections.IDictionary] -and $inputRecord.Contains('restartCommitted')
    if ($observeCommitted) { $fields += 'restartCommitted' }
    $observeState = $observeCommitted -and ($inputRecord.Contains('restartStateIntent') -or $inputRecord.Contains('restartState'))
    if ($observeState) { $fields += @('restartStateIntent', 'restartState') }
    $retireRestart = $observeCommitted -and -not $observeState -and $inputRecord.Contains('retireRestart')
    $observeRetirement = $observeCommitted -and -not $observeState -and $inputRecord.Contains('restartRetirement')
    if ($observeRetirement) { $fields += 'restartRetirement' }
    if ($Hold -and (-not $retireRestart -or $observeRetirement)) { throw 'Held restart observation requires a fresh retirement.' }
    if ($retireRestart) {
        $fields += 'retireRestart'
        if ($inputRecord.retireRestart -isnot [bool] -or $inputRecord.retireRestart -ne $true) {
            throw 'Restart lock retirement request differs.'
        }
    }
    Assert-AgentsChatRetirementFields $inputRecord $fields
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-observation.ps1')
    if ($observeState) {
        . (Join-Path $Source 'windows-stopped-history-handoff-restart-state-observation.ps1')
        $scope = Open-AgentsChatStoppedHistoryHandoffRestartStateObservation $Control $ControllerPid $ControllerIdentity `
            $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
            $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart `
            $inputRecord.restartCommitted $inputRecord.restartStateIntent $inputRecord.restartState
        $observation = Get-AgentsChatStoppedHistoryHandoffRestartStateObservation $scope $ControllerPid $ControllerIdentity
        if ($scope.HistoryHandoffRestartStateObserver -ne $true -or
            $scope.HistoryHandoffRestartCommittedObserver -ne $true -or
            $scope.HistoryHandoffRestartLockObserver -ne $true -or
            $scope.ContainsKey('HistoryHandoffRestartCommitter') -or
            $scope.ContainsKey('HistoryHandoffRestartLockPublisher') -or
            $scope.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
            $scope.ContainsKey('HistoryHandoffRestartStateIntender') -or
            $scope.ContainsKey('HistoryHandoffRestartStateWriter')) {
            throw 'Restart state observer gained a mutation role.'
        }
        foreach ($case in @(
            @{ name='Publish-AgentsChatStoppedHistoryHandoffRestartStateIntent'; message='Restart state intent requires its independent native role.' },
            @{ name='Write-AgentsChatStoppedHistoryHandoffRestartState'; message='Restart state write requires its independent native role.' }
        )) {
            $refused = $false
            try { $null = & $case.name $scope $ControllerPid $ControllerIdentity }
            catch {
                if ($_.Exception.Message -cne $case.message) { throw }
                $refused = $true
            }
            if (-not $refused) { throw 'Read-only restart state observer accepted mutation.' }
        }
        [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 12 -Compress))
        return
    }
    if ($observeRetirement) {
        . (Join-Path $Source 'windows-stopped-history-handoff-restart-retirement.ps1')
        $scope = Open-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $Control $ControllerPid $ControllerIdentity `
            $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
            $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart `
            $inputRecord.restartCommitted $inputRecord.restartRetirement
        $observation = Get-AgentsChatStoppedHistoryHandoffRestartRetirementObservation $scope $ControllerPid $ControllerIdentity
        if ($scope.HistoryHandoffRestartRetirementObserver -ne $true -or
            $scope.HistoryHandoffRestartCommittedObserver -ne $true -or
            $scope.ContainsKey('HistoryHandoffRestartRetirer') -or
            $scope.ContainsKey('HistoryHandoffRestartCommitter') -or
            $scope.ContainsKey('HistoryHandoffRestartStateIntender') -or
            $scope.ContainsKey('HistoryHandoffRestartStateWriter')) {
            throw 'Restart lock retirement observer gained a mutation role.'
        }
        $refused = $false
        try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartRetirement $scope $ControllerPid $ControllerIdentity }
        catch {
            if ($_.Exception.Message -cne 'Restart lock retirement requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Read-only restart lock retirement observer accepted mutation.' }
        if ($retireRestart) {
            # A fresh retirer must not replace or duplicate a dead retirer's exact intent.
            $scope.HistoryHandoffRestartRetirer = $true
            $null = Publish-AgentsChatStoppedHistoryHandoffRestartRetirement $scope $ControllerPid $ControllerIdentity
            throw 'Fresh restart lock retirer duplicated an observed intent.'
        }
        [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 12 -Compress))
        return
    }
    if ($observeCommitted) {
        . (Join-Path $Source 'windows-stopped-history-handoff-restart-committed-observation.ps1')
        . (Join-Path $Source 'windows-stopped-history-handoff-restart-state-intent.ps1')
        $scope = Open-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $Control $ControllerPid $ControllerIdentity `
            $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
            $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart `
            $inputRecord.restartCommitted
        $observation = Get-AgentsChatStoppedHistoryHandoffRestartCommittedObservation $scope $ControllerPid $ControllerIdentity
        if ($scope.HistoryHandoffRestartCommittedObserver -ne $true -or
            $scope.HistoryHandoffRestartLockObserver -ne $true -or
            $scope.ContainsKey('HistoryHandoffRestartCommitter') -or
            $scope.ContainsKey('HistoryHandoffRestartLockPublisher') -or
            $scope.ContainsKey('HistoryHandoffRestartOwnerPublisher') -or
            $scope.ContainsKey('HistoryHandoffRestartStateIntender') -or
            $scope.ContainsKey('HistoryHandoffRestartStateWriter')) {
            throw 'Restart committed observer gained a mutation role.'
        }
        foreach ($case in @(
            @{ name='Complete-AgentsChatStoppedHistoryHandoffRestartCommit'; message='Restart commitment requires its independent native role.' },
            @{ name='Publish-AgentsChatStoppedHistoryHandoffRestartStateIntent'; message='Restart state intent requires its independent native role.' }
        )) {
            $refused = $false
            try { $null = & $case.name $scope $ControllerPid $ControllerIdentity }
            catch {
                if ($_.Exception.Message -cne $case.message) { throw }
                $refused = $true
            }
            if (-not $refused) { throw 'Read-only restart committed observer accepted mutation.' }
        }
        if ($retireRestart) {
            . (Join-Path $Source 'windows-stopped-history-handoff-restart-retirement.ps1')
            $refused = $false
            try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartRetirement $scope $ControllerPid $ControllerIdentity }
            catch {
                if ($_.Exception.Message -cne 'Restart lock retirement requires its independent native role.') { throw }
                $refused = $true
            }
            if (-not $refused -or $scope.ContainsKey('HistoryHandoffRestartRetirement')) {
                throw 'Restart committed observer retired the lock without its role.'
            }
            $scope.HistoryHandoffRestartRetirer = $true
            $observation = Publish-AgentsChatStoppedHistoryHandoffRestartRetirement $scope $ControllerPid $ControllerIdentity
            if (-not (Test-Path -LiteralPath (Join-Path $Control 'lock\owner.json') -PathType Leaf)) {
                throw 'Restart lock retirement intent removed the dead owner.'
            }
            if ($Hold) {
                [Console]::Out.WriteLine((@{
                    type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
                    control=$Control; controllerIdentity=$ControllerIdentity; value=$observation
                } | ConvertTo-Json -Depth 12 -Compress))
                [Console]::Out.Flush()
                $null = [Console]::In.ReadLine()
                throw 'Held restart lock retirement fixture received unexpected controller input.'
            }
            $refused = $false
            try { $null = Publish-AgentsChatStoppedHistoryHandoffRestartRetirement $scope $ControllerPid $ControllerIdentity }
            catch {
                if ($_.Exception.Message -cne 'Restart lock retirement failed; retain evidence.') { throw }
                $refused = $true
            }
            if (-not $refused) { throw 'Restart lock retirement accepted a duplicate intent.' }
        }
        [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 12 -Compress))
        return
    }
    $scope = Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
        $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
        $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart
    $observation = Get-AgentsChatStoppedHistoryHandoffRestartPreparedObservation $scope $ControllerPid $ControllerIdentity
    if ($scope.HistoryHandoffRestartObserver -ne $true -or
        $scope.ContainsKey('HistoryHandoffRestartPreparer') -or
        $scope.ContainsKey('HistoryHandoffRestartPublisher')) {
        throw 'Restart observer gained a preparation or publication role.'
    }
    $mutation = @{
        Context=$scope; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    foreach ($case in @(
        @{ name='Get-AgentsChatStoppedHistoryHandoffRestartRecord'; message='Restart preparation requires its independent native role.' },
        @{ name='Publish-AgentsChatStoppedHistoryHandoffRestartPrepared'; message='Restart publication requires its independent native role.' }
    )) {
        $refused = $false
        try { $null = & $case.name @mutation }
        catch {
            if ($_.Exception.Message -cne $case.message) { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Read-only restart observer accepted mutation.' }
    }
    [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 12 -Compress))
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Native restart observation fixture failed: $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Native restart observation fixture cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Restart observation and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
