param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$CreatedAt,
    [switch]$ReopenPrepared,
    [string]$PreparedDev,
    [string]$PreparedIno,
    [int]$PreparedBytes,
    [string]$PreparedSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-AgentsChatHandoffPreparationObservation(
    [hashtable]$Context, [hashtable]$Preparation, [hashtable]$OwnerRequest, $Descriptor, $File
) {
    if ($null -eq $Descriptor) {
        $null = Get-AgentsChatStoppedHistoryHandoffPreparedRecord @Preparation
    } else {
        foreach ($pass in (Get-AgentsChatVerificationPasses)) {
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($Descriptor.path)
            Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding $Context $Preparation.AttemptId $OwnerRequest $File
            Assert-AgentsChatStoppedHistoryHandoffNamespace $Context @($Descriptor.path)
        }
    }
    return [ordered]@{
        status=$(if ($null -eq $Descriptor) { 'stopped-history-handoff-ready' } else { 'stopped-history-handoff-prepared' })
        attemptId=$Preparation.AttemptId; previousOperationId=$Context.OperationId
        project=$Context.Project
        prepared=$(if ($null -eq $Descriptor) { $null }
            else { Get-AgentsChatStoppedHandoffDescriptor $File $Descriptor.path 1048576 })
    }
}

$scope = $watch = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported handoff preparation platform.' }
    Add-Type -Path @(
        'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
        'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
        ForEach-Object { Join-Path $PSScriptRoot $_ })
    . (Join-Path $PSScriptRoot 'windows-inactive-worker-cleanup.ps1')
    . (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-preparation.ps1')
    . (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-json.ps1')
    . (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-namespace.ps1')
    . (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-live.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'archive-open'
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $scope.HistoryHandoffPreparer = $true
    $preparation = @{
        Context=$scope; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
    }
    $ownerRequest = @{
        Project=$scope.Project; PreviousOperationId=$scope.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=(Get-AgentsChatStoppedHistoryHandoffStateUpdatedAt $scope)
        ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $descriptor = $file = $null
    if ($ReopenPrepared) {
        Assert-AgentsChatCompletionGuid $AttemptId
        $name = "inactive-handoff-$AttemptId-prepared.json"
        $descriptor = @{
            path=$name; dev=$PreparedDev; ino=$PreparedIno
            bytes=$PreparedBytes; sha256=$PreparedSha256
        }
        Assert-AgentsChatRetirementDescriptor $descriptor $name 1048576
        $file = Open-AgentsChatRetirementFile $scope $descriptor $name
    }
    $value = Get-AgentsChatHandoffPreparationObservation $scope $preparation $ownerRequest $descriptor $file
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; control=$Control
        controllerIdentity=$ControllerIdentity; value=$value
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'publish', 'close')) {
            throw 'Invalid handoff preparation request.'
        }
        $sequence = $id
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original preparation actor changed.'
        }
        $stage = $method
        if ($method -ceq 'close') {
            Close-AgentsChatTaskCompletionProof $scope
            $scope = $null
            $value = 'close'
        } else {
            if ($method -ceq 'publish') {
                $descriptor = Publish-AgentsChatStoppedHistoryHandoffPrepared @preparation
                $file = Open-AgentsChatRetirementFile $scope $descriptor $descriptor.path
            }
            $value = Get-AgentsChatHandoffPreparationObservation $scope $preparation $ownerRequest $descriptor $file
        }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Handoff preparation refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Handoff preparation cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Handoff preparation and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
