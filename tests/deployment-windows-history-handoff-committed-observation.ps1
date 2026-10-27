param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$PreparedDev,
    [Parameter(Mandatory)][string]$PreparedIno,
    [Parameter(Mandatory)][int]$PreparedBytes,
    [Parameter(Mandatory)][string]$PreparedSha256,
    [Parameter(Mandatory)][string]$CommittedDev,
    [Parameter(Mandatory)][string]$CommittedIno,
    [Parameter(Mandatory)][int]$CommittedBytes,
    [Parameter(Mandatory)][string]$CommittedSha256,
    [switch]$PrepareRetirement,
    [switch]$Hold,
    [switch]$ObserveRetirement,
    [switch]$RetireOwner,
    [switch]$RetireDirectory,
    [switch]$SettleRetirement,
    [switch]$ObserveSettlement,
    [switch]$PrepareSuccessor,
    [switch]$PublishSuccessor,
    [switch]$PhasedPublication,
    [switch]$ObserveSuccessor,
    [switch]$SealSuccessor,
    [switch]$ObserveSuccessorAbandoned,
    [switch]$PrepareRestart,
    [string]$AbandonedDev,
    [string]$AbandonedIno,
    [int]$AbandonedBytes,
    [string]$AbandonedSha256,
    [string]$SuccessorAttemptId,
    [string]$SuccessorDev,
    [string]$SuccessorIno,
    [int]$SuccessorBytes,
    [string]$SuccessorSha256,
    [string]$TerminalDev,
    [string]$TerminalIno,
    [int]$TerminalBytes,
    [string]$TerminalSha256,
    [string]$RetirementDev,
    [string]$RetirementIno,
    [int]$RetirementBytes,
    [string]$RetirementSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $failure = $null
try {
    if (($ObserveSuccessor -and (-not $ObserveSettlement -or $PrepareSuccessor -or $PublishSuccessor)) -or
        ($ObserveSuccessorAbandoned -and (-not $ObserveSuccessor -or $SealSuccessor)) -or
        ($PrepareRestart -and -not $ObserveSuccessorAbandoned) -or
        ($PhasedPublication -and -not $PublishSuccessor) -or
        ($SealSuccessor -and -not $ObserveSuccessor) -or
        ($PublishSuccessor -and -not $PrepareSuccessor) -or
        ($PrepareSuccessor -and -not $ObserveSettlement) -or
        ($Hold -and -not ($PrepareRetirement -or $RetireOwner -or $RetireDirectory -or $SettleRetirement -or $PublishSuccessor -or $SealSuccessor)) -or
        ($ObserveRetirement -and $PrepareRetirement) -or ($RetireOwner -and -not $ObserveRetirement) -or
        ($RetireDirectory -and (-not $ObserveRetirement -or $RetireOwner)) -or
        ($SettleRetirement -and (-not $ObserveRetirement -or $RetireOwner -or $RetireDirectory -or $ObserveSettlement)) -or
        ($ObserveSettlement -and (-not $ObserveRetirement -or $RetireOwner -or $RetireDirectory -or
            ($Hold -and -not ($PublishSuccessor -or $SealSuccessor))))) {
        throw 'Invalid native retirement fixture mode.'
    }
    Add-Type -Path @(
        'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
        'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
        ForEach-Object { Join-Path $Source $_ })
    . (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
    . (Join-Path $Source 'windows-stopped-history-handoff-committed-observation.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $prepared = @{
        path="inactive-handoff-$AttemptId-prepared.json"
        dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
    }
    $committed = @{
        path="inactive-handoff-$AttemptId-committed.json"
        dev=$CommittedDev; ino=$CommittedIno; bytes=$CommittedBytes; sha256=$CommittedSha256
    }
    if ($ObserveRetirement) {
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-retirement-observation.ps1')
        $retirement = @{
            path="inactive-handoff-$AttemptId-lock-retirement.json"
            dev=$RetirementDev; ino=$RetirementIno; bytes=$RetirementBytes; sha256=$RetirementSha256
        }
        if ($ObserveSettlement) {
            . (Join-Path $Source 'windows-stopped-history-handoff-lock-settlement-observation.ps1')
            $terminal = @{
                path="inactive-handoff-$AttemptId-lock-retired.json"
                dev=$TerminalDev; ino=$TerminalIno; bytes=$TerminalBytes; sha256=$TerminalSha256
            }
            if ($ObserveSuccessor) {
                . (Join-Path $Source 'windows-stopped-history-handoff-successor-observation.ps1')
                $successor = @{
                    path="inactive-handoff-$SuccessorAttemptId-prepared.json"
                    dev=$SuccessorDev; ino=$SuccessorIno; bytes=$SuccessorBytes; sha256=$SuccessorSha256
                }
                if ($ObserveSuccessorAbandoned) {
                    . (Join-Path $Source 'windows-stopped-history-handoff-successor-abandoned-observation.ps1')
                    $abandoned = @{
                        path="inactive-handoff-$SuccessorAttemptId-abandoned.json"
                        dev=$AbandonedDev; ino=$AbandonedIno; bytes=$AbandonedBytes; sha256=$AbandonedSha256
                    }
                    $scope = Open-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $Control `
                        $ControllerPid $ControllerIdentity $AttemptId $prepared $committed $retirement $terminal $successor $abandoned
                    $observation = Get-AgentsChatStoppedHistoryHandoffSuccessorAbandonedObservation $scope `
                        $ControllerPid $ControllerIdentity
                    if ($scope.ContainsKey('HistoryHandoffSuccessorAbandoner') -or
                        $scope.HistoryHandoffSuccessorAbandonedObserver -ne $true) {
                        throw 'Abandoned successor reader gained a mutation role.'
                    }
                    $refused = $false
                    try { $null = Publish-AgentsChatStoppedHistoryHandoffSuccessorAbandoned $scope $ControllerPid $ControllerIdentity }
                    catch {
                        if ($_.Exception.Message -cne 'Successor abandonment requires its independent native role.') { throw }
                        $refused = $true
                    }
                    if (-not $refused) { throw 'Abandoned successor reader accepted terminal publication.' }
                    if ($PrepareRestart) {
                        [Console]::Out.WriteLine((@{
                            type='successor-settlement-observed'; pid=$PID
                            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
                            control=$Control; controllerIdentity=$ControllerIdentity; value=$observation
                        } | ConvertTo-Json -Depth 8 -Compress))
                        [Console]::Out.Flush()
                        if ([Console]::In.ReadLine() -cne '{"type":"prepare"}') {
                            throw 'Restart preparation requires its exact command.'
                        }
                        . (Join-Path $PSScriptRoot 'deployment-windows-history-handoff-restart.ps1')
                        $observation = Test-AgentsChatStoppedHistoryHandoffRestart $Source $scope `
                            $ControllerPid $ControllerIdentity
                    }
                } else {
                    $scope = Open-AgentsChatStoppedHistoryHandoffSuccessorObservation $Control `
                        $ControllerPid $ControllerIdentity $AttemptId $prepared $committed $retirement $terminal $successor
                    $observation = Get-AgentsChatStoppedHistoryHandoffSuccessorPreparedObservation $scope `
                        $ControllerPid $ControllerIdentity
                }
                if ($scope.ContainsKey('HistoryHandoffSuccessorPreparer') -or
                    $scope.ContainsKey('HistoryHandoffSuccessorPublisher') -or
                    $scope.HistoryHandoffSuccessorObserver -ne $true) {
                    throw 'Successor reader gained a mutation role.'
                }
                $request = @{
                    Context=$scope; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
                    AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
                    Token=[guid]::NewGuid().ToString()
                    CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
                }
                foreach ($case in @(
                    @{ name='Get-AgentsChatStoppedHistoryHandoffSuccessorRecord'; message='Successor preparation requires its independent native role.' },
                    @{ name='Publish-AgentsChatStoppedHistoryHandoffSuccessorPrepared'; message='Successor publication requires its independent native role.' }
                )) {
                    $refused = $false
                    try { $null = & $case.name @request }
                    catch {
                        if ($_.Exception.Message -cne $case.message) { throw }
                        $refused = $true
                    }
                    if (-not $refused) { throw 'Successor reader accepted a preparation or publication mutation.' }
                }
                if ($SealSuccessor) {
                    [Console]::Out.WriteLine((@{
                        type='successor-observed'; pid=$PID
                        processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
                        control=$Control; controllerIdentity=$ControllerIdentity; value=$observation
                    } | ConvertTo-Json -Depth 8 -Compress))
                    [Console]::Out.Flush()
                    if ([Console]::In.ReadLine() -cne '{"type":"seal"}') {
                        throw 'Successor settlement requires its exact sealing command.'
                    }
                    . (Join-Path $PSScriptRoot 'deployment-windows-history-handoff-successor-abandonment.ps1')
                    $observation = Test-AgentsChatStoppedHistoryHandoffSuccessorAbandonment $Source $scope `
                        $ControllerPid $ControllerIdentity -Hold:$Hold
                }
            } elseif ($PublishSuccessor) {
                $scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control `
                    $ControllerPid $ControllerIdentity $AttemptId $prepared $committed `
                    -Retirement $retirement -Terminal $terminal
            } else {
                $scope = Open-AgentsChatStoppedHistoryHandoffLockSettlementObservation $Control `
                    $ControllerPid $ControllerIdentity $AttemptId $prepared $committed $retirement $terminal
                $observation = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $scope `
                    $ControllerPid $ControllerIdentity
            }
        } else {
            $scope = Open-AgentsChatStoppedHistoryHandoffLockRetirementObservation $Control `
                $ControllerPid $ControllerIdentity $AttemptId $prepared $committed $retirement
            $observation = Get-AgentsChatStoppedHistoryHandoffLockRetirementObservation $scope `
                $ControllerPid $ControllerIdentity
        }
    } else {
        $scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control `
            $ControllerPid $ControllerIdentity $AttemptId $prepared $committed
        $observation = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $scope `
            $ControllerPid $ControllerIdentity
    }
    if ($PrepareRetirement) {
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-retirement-intent.ps1')
        $refused = $false
        try {
            $null = Publish-AgentsChatStoppedHistoryHandoffLockRetirementIntent $scope $ControllerPid $ControllerIdentity
        } catch {
            if ($_.Exception.Message -cne 'Handoff lock retirement preparation requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Lock retirement preparation accepted a scope without its independent role.' }
        $scope.HistoryHandoffLockRetirer = $true
        $observation = Publish-AgentsChatStoppedHistoryHandoffLockRetirementIntent $scope $ControllerPid $ControllerIdentity
        $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $Control $observation.path)))
        try {
            $creator = $document.RootElement.GetProperty('creator')
            if ($creator.GetProperty('bridgePid').GetInt32() -ne $PID -or
                $creator.GetProperty('bridgeIdentity').GetString() -cne
                    [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
                throw 'Lock retirement intent does not identify its actual native bridge.'
            }
        } finally { $document.Dispose() }
    }
    if ($RetireOwner) {
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-retirement-owner.ps1')
        $refused = $false
        try {
            $null = Remove-AgentsChatStoppedHistoryHandoffLockOwner $scope $ControllerPid $ControllerIdentity
        } catch {
            if ($_.Exception.Message -cne 'Handoff owner retirement requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Owner retirement accepted a scope without its independent role.' }
        $scope.HistoryHandoffLockRetirementExecutor = $true
        $observation = Remove-AgentsChatStoppedHistoryHandoffLockOwner $scope $ControllerPid $ControllerIdentity
        if ($observation.status -cne 'lock-retirement-owner-retired' -or
            (Test-Path -LiteralPath (Join-Path $Control 'lock\owner.json')) -or
            @(Get-ChildItem -LiteralPath (Join-Path $Control 'lock') -Force).Count) {
            throw 'Native owner retirement did not preserve an exact empty directory.'
        }
        $identity = $scope.HistoryHandoffLock.Directory.CaptureIdentity()
        if ($identity.Dev -cne $observation.lockIdentity.dev -or $identity.Ino -cne $observation.lockIdentity.ino) {
            throw 'Native owner retirement changed its original directory identity.'
        }
    }
    if ($RetireDirectory) {
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-retirement-directory.ps1')
        $refused = $false
        try {
            $null = Remove-AgentsChatStoppedHistoryHandoffLockDirectory $scope $ControllerPid $ControllerIdentity
        } catch {
            if ($_.Exception.Message -cne 'Handoff directory retirement requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Directory retirement accepted a scope without its independent role.' }
        $scope.HistoryHandoffLockDirectoryRetirementExecutor = $true
        $observation = Remove-AgentsChatStoppedHistoryHandoffLockDirectory $scope $ControllerPid $ControllerIdentity
        if ($observation.status -cne 'lock-retirement-directory-retired' -or
            (Test-Path -LiteralPath (Join-Path $Control 'lock'))) {
            throw 'Native directory retirement did not preserve its exact absent stage.'
        }
    }
    if ($SettleRetirement) {
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-settlement.ps1')
        $refused = $false
        try {
            $null = Publish-AgentsChatStoppedHistoryHandoffLockSettlement $scope $ControllerPid $ControllerIdentity
        } catch {
            if ($_.Exception.Message -cne 'Handoff lock settlement requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Lock settlement accepted a scope without its independent role.' }
        $scope.HistoryHandoffLockSettler = $true
        $terminal = Publish-AgentsChatStoppedHistoryHandoffLockSettlement $scope $ControllerPid $ControllerIdentity
        . (Join-Path $Source 'windows-stopped-history-handoff-lock-settlement-observation.ps1')
        $observation = Get-AgentsChatStoppedHistoryHandoffLockSettlementObservation $scope $ControllerPid $ControllerIdentity
        $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $Control $terminal.path)))
        try {
            $creator = $document.RootElement.GetProperty('creator')
            if ($creator.GetProperty('bridgePid').GetInt32() -ne $PID -or
                $creator.GetProperty('bridgeIdentity').GetString() -cne
                    [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
                throw 'Lock settlement does not identify its actual native publisher.'
            }
        } finally { $document.Dispose() }
    }
    if ($PrepareSuccessor) {
        if ($PublishSuccessor) {
            . (Join-Path $PSScriptRoot 'deployment-windows-history-handoff-successor-publication.ps1')
            $observation = Test-AgentsChatStoppedHistoryHandoffSuccessorPublication $Source $scope `
                $ControllerPid $ControllerIdentity -Hold:$Hold -PhasedPublication:$PhasedPublication
        } else {
            . (Join-Path $PSScriptRoot 'deployment-windows-history-handoff-successor.ps1')
            $observation = Test-AgentsChatStoppedHistoryHandoffSuccessor $Source $scope $ControllerPid $ControllerIdentity
        }
    }
    if ($Hold) {
        if ($PublishSuccessor) { $observation = $observation.observation }
        [Console]::Out.WriteLine((@{
            type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Control; controllerIdentity=$ControllerIdentity; value=$observation
        } | ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        $null = [Console]::In.ReadLine()
        throw 'Held lock retirement fixture received unexpected controller input.'
    }
    if ($PhasedPublication) {
        $observation.Remove('record')
        [Console]::Out.WriteLine((@{
            type='publication-complete'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Control; controllerIdentity=$ControllerIdentity; value=$observation
        } | ConvertTo-Json -Depth 8 -Compress))
    } else {
        [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 14 -Compress))
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Native committed handoff observation fixture failed: $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Native committed handoff observation fixture cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Native committed handoff observation and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
