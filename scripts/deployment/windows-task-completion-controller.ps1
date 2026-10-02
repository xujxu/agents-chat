param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [switch]$Retirement,
    [switch]$DeploymentRetirement
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$proof = $scope = $deployment = $watch = $null
$stage = 'bootstrap'
$failure = $null
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported proof bridge platform.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeListener.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-completion-proof.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement-intent.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement-checkpoint.ps1')
    . (Join-Path $PSScriptRoot 'windows-task-retirement-scope.ps1')
    . (Join-Path $PSScriptRoot 'windows-deployment-retirement-evidence.ps1')
    . (Join-Path $PSScriptRoot 'windows-deployment-retirement.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'proof-open'
    if ($Retirement -and $DeploymentRetirement) { throw 'Ambiguous retirement mode.' }
    if ($DeploymentRetirement) {
        $stage = 'deployment-retirement-open'
        $deployment = Open-AgentsChatDeploymentRetirement -Control $Control `
            -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        $observed = Assert-AgentsChatDeploymentRetirement $deployment
    } elseif ($Retirement) {
        $stage = 'retirement-open'
        $scope = Open-AgentsChatTaskRetirement -Control $Control `
            -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        $observed = Assert-AgentsChatTaskRetirement $scope
    } else {
        $proof = Open-AgentsChatTaskCompletionProof -Control $Control
        $observed = Assert-AgentsChatTaskCompletionProof -Context $proof
    }
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity; value=$observed
    } | ConvertTo-Json -Depth 16 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @(
            'check', 'close', 'prepare-retirement', 'prepare-retirement-checkpoint', 'begin-retirement', 'retire-next',
            'retain-workers', 'begin-deployment-retirement', 'retire-deployment-next')) {
            throw 'Invalid completed-task proof request.'
        }
        $sequence = $id
        $stage = 'controller'
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original completed-task proof controller changed.'
        }
        $stage = $method
        if (($scope -and $method -cnotin @('check', 'close', 'retire-next', 'retain-workers', 'begin-deployment-retirement')) -or
            ($deployment -and $method -cnotin @('check', 'close', 'retire-deployment-next')) -or
            ($proof -and $method -cin @('retire-next', 'retain-workers', 'begin-deployment-retirement', 'retire-deployment-next'))) {
            throw 'Request does not match retained native authority.'
        }
        $finished = $false
        if ($method -ceq 'close') {
            if ($deployment) { Close-AgentsChatTaskCompletionProof $deployment; $deployment = $null }
            if ($scope) { Close-AgentsChatTaskCompletionProof $scope; $scope = $null }
            if ($proof) { Close-AgentsChatTaskCompletionProof $proof; $proof = $null }
            $value = 'close'
        } elseif ($method -ceq 'retain-workers') {
            $value = Retain-AgentsChatDeploymentWorkers $scope
        } elseif ($method -ceq 'begin-deployment-retirement') {
            Publish-AgentsChatDeploymentRetirement $scope
            $deployment = Open-AgentsChatDeploymentRetirement -Control $Control `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
            $null = Assert-AgentsChatTaskRetirement $scope
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = Assert-AgentsChatDeploymentRetirement $deployment
        } elseif ($method -ceq 'retire-deployment-next') {
            $value = Remove-AgentsChatNextDeploymentEntry $deployment
            if ($value.status -ceq 'retired') { $deployment = $null; $finished = $true }
        } elseif ($method -ceq 'begin-retirement') {
            $null = Prepare-AgentsChatTaskRetirementCheckpoint -Context $proof `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
            $scope = Open-AgentsChatTaskRetirement -Control $Control `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
            $null = Assert-AgentsChatTaskCompletionProof $proof
            Close-AgentsChatTaskCompletionProof $proof
            $proof = $null
            $value = Assert-AgentsChatTaskRetirement $scope
        } elseif ($method -ceq 'retire-next') {
            $value = Remove-AgentsChatNextRetirementFile $scope
        } elseif ($method -ceq 'prepare-retirement') {
            $value = Prepare-AgentsChatTaskRetirement -Context $proof `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        } elseif ($method -ceq 'prepare-retirement-checkpoint') {
            $value = Prepare-AgentsChatTaskRetirementCheckpoint -Context $proof `
                -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
        } elseif ($deployment) { $value = Assert-AgentsChatDeploymentRetirement $deployment }
        elseif ($scope) { $value = Assert-AgentsChatTaskRetirement $scope }
        else { $value = Assert-AgentsChatTaskCompletionProof -Context $proof }
        [Console]::Out.WriteLine((@{
            id=$id; type='reply'; value=$value
            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        } | ConvertTo-Json -Depth 16 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close' -or $finished) { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Completed-task proof refused: $stage. $($failure.GetBaseException().Message)")
} finally {
    if ($deployment) {
        try { Close-AgentsChatTaskCompletionProof $deployment }
        catch {
            [Console]::Error.WriteLine('Deployment retirement cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Deployment retirement and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($scope) {
        try { Close-AgentsChatTaskCompletionProof $scope }
        catch {
            [Console]::Error.WriteLine('Retirement authority cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Retirement and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($proof) {
        try { Close-AgentsChatTaskCompletionProof -Context $proof }
        catch {
            [Console]::Error.WriteLine('Completed-task proof cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Proof and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($watch) {
        try { $watch.Dispose() }
        catch {
            [Console]::Error.WriteLine('Completed-task proof owner watch cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Proof and owner watch cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
