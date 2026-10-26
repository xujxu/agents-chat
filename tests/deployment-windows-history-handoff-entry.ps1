param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$CreatedAt,
    [switch]$Publish,
    [switch]$Hold
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Hold -and -not $Publish) { throw 'Held preparation requires explicit publication.' }
Add-Type -Path @(
    'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
    'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
    ForEach-Object { Join-Path $Source $_ })
. (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
. (Join-Path $Source 'windows-stopped-history-handoff-record.ps1')
if ($Publish) { . (Join-Path $Source 'windows-stopped-history-handoff-preparation.ps1') }
$scope = $watch = $null
try {
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $record = if ($Publish) {
        $scope.HistoryHandoffPreparer = $true
        Publish-AgentsChatStoppedHistoryHandoffPrepared $scope $ControllerPid $ControllerIdentity `
            $AttemptId $OperationId $Token $CreatedAt
    } else {
        Get-AgentsChatStoppedHistoryHandoffPreparedRecord $scope $ControllerPid $ControllerIdentity `
            $AttemptId $OperationId $Token $CreatedAt
    }
    if ($Hold) {
        [Console]::Out.WriteLine((@{
            type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Control; controllerIdentity=$ControllerIdentity; value=$record
        } | ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $null = $line.GetAwaiter().GetResult()
        throw 'Held preparation fixture does not accept commands.'
    }
    [Console]::Out.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress))
} finally {
    try { if ($scope) { Close-AgentsChatTaskCompletionProof $scope } }
    finally { if ($watch) { $watch.Dispose() } }
}
