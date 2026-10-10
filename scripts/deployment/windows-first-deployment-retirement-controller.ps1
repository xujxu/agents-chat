param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $watch = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.4') { throw 'Unsupported first retirement platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-first-deployment-retirement.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'first-retirement-open'
    if (Test-Path -LiteralPath (Join-Path $Control 'worker-retirement.json')) {
        $scope = Open-AgentsChatFirstDeploymentRetirement $Control $ControllerPid $ControllerIdentity
        $record = $scope.Record
        $value = Assert-AgentsChatFirstDeploymentRetirement $scope
    } else {
        $scope = Open-AgentsChatFirstCompletionProof -Control $Control -Recovery
        $record = New-AgentsChatFirstRetirementCandidate $scope $ControllerPid $ControllerIdentity
        $value = $null
    }
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; control=$Control
        controllerIdentity=$ControllerIdentity; record=$record; value=$value
    } | ConvertTo-Json -Depth 16 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('begin', 'check', 'advance', 'close')) {
            throw 'Invalid first retirement request.'
        }
        $sequence = $id
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Current first retirement actor changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = 'close'
        } elseif ($method -ceq 'begin') {
            $scope = Publish-AgentsChatFirstDeploymentRetirement $scope $ControllerPid $ControllerIdentity
            $value = Assert-AgentsChatFirstDeploymentRetirement $scope
        } else {
            if ($scope.Preparing) { throw 'First retirement candidate has not been verified and published.' }
            $value = if ($method -ceq 'advance') { Remove-AgentsChatNextFirstRetirementEntry $scope }
                else { Assert-AgentsChatFirstDeploymentRetirement $scope }
        }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("First deployment retirement refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('First deployment retirement cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('First retirement and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
