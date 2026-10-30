param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$CreatedAt,
    [Parameter(Mandatory)][string]$PreparedDev,
    [Parameter(Mandatory)][string]$PreparedIno,
    [Parameter(Mandatory)][int]$PreparedBytes,
    [Parameter(Mandatory)][string]$PreparedSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# One-shot first-attempt bridge: the live controller's prepared handoff becomes its committed lock, its exact
# state-transition intent and its written preflight; the bridge then exits so only handoff-aware admission remains.
$scope = $watch = $failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported handoff commit platform.' }
    Add-Type -Path @(
        'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
        'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
        ForEach-Object { Join-Path $PSScriptRoot $_ })
    . (Join-Path $PSScriptRoot 'windows-inactive-worker-cleanup.ps1')
    . (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-state-intent.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    Assert-AgentsChatCompletionGuid $AttemptId
    $stage = 'archive-open'
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $scope.HistoryHandoffLockPublisher = $true
    $name = "inactive-handoff-$AttemptId-prepared.json"
    $descriptor = @{ path=$name; dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256 }
    Assert-AgentsChatRetirementDescriptor $descriptor $name 1048576
    $stage = 'commit'
    $committed = Publish-AgentsChatStoppedHistoryHandoffCommitted $scope $descriptor `
        $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
    $stage = 'state-intent'
    $stateIntent = Publish-AgentsChatStoppedHistoryHandoffStateIntent $scope $ControllerPid $ControllerIdentity
    $stage = 'state-write'
    $state = Write-AgentsChatStoppedHistoryHandoffState $scope $ControllerPid $ControllerIdentity
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Original handoff commit actor changed.'
    }
    $stage = 'close'
    Close-AgentsChatTaskCompletionProof $scope
    $scope = $null
    [Console]::Out.WriteLine((@{
        type='result'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity
        value=@{ committed=$committed; stateIntent=$stateIntent; state=$state }
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Handoff commit refused: $stage. $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Handoff commit cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Handoff commit and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
