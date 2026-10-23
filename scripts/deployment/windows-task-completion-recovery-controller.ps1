param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [switch]$Inactive,
    [switch]$LostRuntime
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
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-completion-recovery.ps1')
    if ($Inactive) { . (Join-Path $PSScriptRoot 'windows-inactive-completion-recovery.ps1') }
    if ($LostRuntime) {
        if (-not $Inactive) { throw 'Lost-runtime mode requires explicit inactive history.' }
        . (Join-Path $PSScriptRoot 'windows-inactive-lost-runtime.ps1')
    }
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'recovery-open'
    $scope = if ($LostRuntime) { Open-AgentsChatInactiveLostRuntimeAuthority $Control }
        elseif ($Inactive) { Open-AgentsChatInactiveCompletionRecovery $Control }
        else { Open-AgentsChatTaskCompletionRecovery $Control }
    $observation = if ($LostRuntime) { Assert-AgentsChatInactiveLostRuntimeEvidence $scope }
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
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'advance', 'close', 'prepare-rollback', 'rollback-files-restored', 'restore-rollback-task', 'advance-rollback-task', 'prepare-rollback-terminal', 'stage-rollback-state', 'publish-rollback-state')) { throw 'Invalid recovery request.' }
        if ($method -cin @('prepare-rollback', 'rollback-files-restored', 'restore-rollback-task', 'advance-rollback-task', 'prepare-rollback-terminal', 'stage-rollback-state', 'publish-rollback-state') -and -not $LostRuntime) { throw 'Rollback intent requires lost-runtime authority.' }
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
        } elseif ($method -ceq 'prepare-rollback') {
            $value = Publish-AgentsChatInactiveRollbackIntent $scope
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
