param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [switch]$Inactive,
    [switch]$LostRuntime,
    [switch]$StoppedRetirement,
    [switch]$StoppedWorkers
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported recovery bridge platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceSecurity.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-completion-recovery.ps1')
    if ($Inactive) { . (Join-Path $PSScriptRoot 'windows-inactive-completion-recovery.ps1') }
    if ($LostRuntime) {
        if (-not $Inactive) { throw 'Lost-runtime mode requires explicit inactive history.' }
        . (Join-Path $PSScriptRoot 'windows-inactive-lost-runtime.ps1')
    }
    if ($StoppedRetirement) {
        if (-not $Inactive -or $LostRuntime) { throw 'Stopped cleanup requires its independent inactive mode.' }
        . (Join-Path $PSScriptRoot 'windows-inactive-rollback-cleanup.ps1')
    }
    if ($StoppedWorkers) {
        if (-not $Inactive -or $LostRuntime -or $StoppedRetirement) { throw 'Stopped worker cleanup requires its independent mode.' }
        . (Join-Path $PSScriptRoot 'windows-inactive-worker-cleanup.ps1')
    }
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'recovery-open'
    $scope = if ($StoppedWorkers) { Open-AgentsChatStoppedWorkerCleanup $Control }
        elseif ($StoppedRetirement) { Open-AgentsChatInactiveRollbackCleanup $Control }
        elseif ($LostRuntime) { Open-AgentsChatInactiveLostRuntimeAuthority $Control }
        elseif ($Inactive) { Open-AgentsChatInactiveCompletionRecovery $Control }
        else { Open-AgentsChatTaskCompletionRecovery $Control }
    $observation = if ($StoppedWorkers) { Assert-AgentsChatStoppedWorkerCleanup $scope }
        elseif ($StoppedRetirement) { Assert-AgentsChatInactiveRollbackCleanup $scope }
        elseif ($LostRuntime) { Assert-AgentsChatInactiveLostRuntimeEvidence $scope }
        elseif ($Inactive) { Assert-AgentsChatInactiveCompletionRecovery $scope }
        else { Assert-AgentsChatTaskCompletionRecovery $scope }
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; control=$Control
        controllerIdentity=$ControllerIdentity; value=$observation
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'advance', 'close', 'prepare-rollback', 'prepare-rollback-runtime', 'release-rollback-runtime', 'rollback-files-restored', 'restore-rollback-task', 'advance-rollback-task', 'prepare-rollback-terminal', 'stage-rollback-state', 'publish-rollback-state', 'complete-rollback', 'prepare-rollback-retirement', 'check-rollback-retirement', 'prepare-stopped-workers', 'prepare-stopped-history')) { throw 'Invalid recovery request.' }
        if ($method -ceq 'prepare-stopped-history' -and -not $StoppedWorkers) { throw 'History archival requires final stopped worker authority.' }
        if ($method -ceq 'prepare-stopped-workers' -and -not $StoppedRetirement) { throw 'Worker checkpoint requires independent stopped cleanup.' }
        if ($StoppedRetirement -and $method -cnotin @('check', 'advance', 'close', 'prepare-stopped-workers')) { throw 'Stopped cleanup cannot mutate rollback receipts.' }
        if ($StoppedWorkers -and $method -cnotin @('check', 'advance', 'close', 'prepare-stopped-history')) { throw 'Stopped worker cleanup cannot mutate rollback receipts.' }
        if ($method -cin @('prepare-rollback', 'prepare-rollback-runtime', 'release-rollback-runtime', 'rollback-files-restored', 'restore-rollback-task', 'advance-rollback-task', 'prepare-rollback-terminal', 'stage-rollback-state', 'publish-rollback-state', 'complete-rollback', 'prepare-rollback-retirement', 'check-rollback-retirement') -and -not $LostRuntime) { throw 'Rollback intent requires lost-runtime authority.' }
        if ($LostRuntime -and $method -ceq 'advance') { throw 'Lost-runtime evidence cannot advance live completion.' }
        $sequence = $id
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original recovery actor changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = 'close'
        } elseif ($StoppedWorkers) {
            $value = if ($method -ceq 'advance') { Remove-AgentsChatNextStoppedWorkerEntry $scope }
                elseif ($method -ceq 'prepare-stopped-history') { Publish-AgentsChatStoppedHistoryArchiveIntent $scope }
                else { Assert-AgentsChatStoppedWorkerCleanup $scope }
        } elseif ($StoppedRetirement) {
            $value = if ($method -ceq 'prepare-stopped-workers') { Publish-AgentsChatStoppedWorkerRetirement $scope }
                elseif ($method -ceq 'advance') { Remove-AgentsChatNextInactiveRollbackEntry $scope }
                else { Assert-AgentsChatInactiveRollbackCleanup $scope }
        } elseif ($method -ceq 'prepare-rollback') {
            $value = Publish-AgentsChatInactiveRollbackIntent $scope
        } elseif ($method -ceq 'prepare-rollback-runtime') {
            $value = Publish-AgentsChatInactiveRollbackRuntimeHandoff $scope
        } elseif ($method -ceq 'release-rollback-runtime') {
            $value = Release-AgentsChatInactiveRollbackRuntimeHandoff $scope
        } elseif ($method -ceq 'rollback-files-restored') {
            $value = Publish-AgentsChatInactiveRollbackFilesReceipt $scope
        } elseif ($method -ceq 'restore-rollback-task') {
            $value = Restore-AgentsChatInactiveRollbackTask $scope
        } elseif ($method -ceq 'advance-rollback-task') {
            $value = Restore-AgentsChatInactiveRollbackTask $scope -SingleStep
        } elseif ($method -ceq 'prepare-rollback-terminal') {
            $value = Publish-AgentsChatInactiveRollbackTerminal $scope
        } elseif ($method -ceq 'stage-rollback-state') {
            $value = Stage-AgentsChatInactiveRollbackState $scope
        } elseif ($method -ceq 'publish-rollback-state') {
            $value = Publish-AgentsChatInactiveRollbackState $scope
        } elseif ($method -ceq 'complete-rollback') {
            $value = Publish-AgentsChatInactiveRollbackCompletion $scope
        } elseif ($method -ceq 'prepare-rollback-retirement') {
            $value = Publish-AgentsChatInactiveRollbackRetirementIntent $scope
        } elseif ($method -ceq 'check-rollback-retirement') {
            $value = Assert-AgentsChatInactiveRollbackRetirementAdmission $scope
        } elseif ($method -ceq 'advance') {
            $value = if ($Inactive) { Advance-AgentsChatInactiveCompletionRecovery $scope }
                else { Advance-AgentsChatTaskCompletionRecovery $scope }
        } else {
            $value = if ($LostRuntime) { Assert-AgentsChatInactiveLostRuntimeEvidence $scope }
                elseif ($Inactive) { Assert-AgentsChatInactiveCompletionRecovery $scope }
                else { Assert-AgentsChatTaskCompletionRecovery $scope }
        }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Completion recovery refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Completion recovery cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Completion recovery and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
