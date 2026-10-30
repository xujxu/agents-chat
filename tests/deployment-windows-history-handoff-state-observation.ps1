param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$Request
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scope = $failure = $null
try {
    Add-Type -Path @(
        'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
        'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
        ForEach-Object { Join-Path $Source $_ })
    . (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
    . (Join-Path $Source 'windows-stopped-history-handoff-state-observation.ps1')
    $value = Read-AgentsChatRetirementJson $Request
    $scope = Open-AgentsChatStoppedHistoryHandoffStateObservation $Control $ControllerPid $ControllerIdentity `
        $value.attemptId $value.prepared $value.committed $value.stateIntent $value.state
    $observed = Get-AgentsChatStoppedHistoryHandoffStateObservation $scope $ControllerPid $ControllerIdentity
    $refusals = [ordered]@{}
    foreach ($role in @('intent', 'write')) {
        $copy = $scope.Clone()
        $copy.Poisoned = $false
        $copy.HistoryHandoffLockPublisher = $true
        try {
            if ($role -ceq 'intent') {
                $null = Publish-AgentsChatStoppedHistoryHandoffStateIntent $copy $ControllerPid $ControllerIdentity
            } else {
                $null = Write-AgentsChatStoppedHistoryHandoffState $copy $ControllerPid $ControllerIdentity
            }
        } catch { $refusals[$role] = $_.Exception.Message }
    }
    if ($refusals.Count -ne 2) { throw 'First-attempt state observer acquired publication authority.' }
    $null = Get-AgentsChatStoppedHistoryHandoffStateObservation $scope $ControllerPid $ControllerIdentity
    [Console]::Out.WriteLine((@{ observed=$observed; refusals=$refusals } | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Native handoff state observation fixture failed: $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    if ($null -ne $scope) {
        try { Close-AgentsChatTaskCompletionProof $scope }
        catch {
            [Console]::Error.WriteLine('Native handoff state observation fixture cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Native handoff state observation fixture and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
