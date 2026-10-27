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
    [switch]$PrepareRetirement
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
    $scope = Open-AgentsChatStoppedHistoryHandoffCommittedObservation $Control `
        $ControllerPid $ControllerIdentity $AttemptId $prepared $committed
    $observation = Get-AgentsChatStoppedHistoryHandoffCommittedObservation $scope `
        $ControllerPid $ControllerIdentity
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
    [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 8 -Compress))
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
