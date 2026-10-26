param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$CreatedAt,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
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
    [Console]::Out.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress))
} finally {
    try { if ($scope) { Close-AgentsChatTaskCompletionProof $scope } }
    finally { if ($watch) { $watch.Dispose() } }
}
