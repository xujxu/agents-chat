param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$Request
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
    . (Join-Path $Source 'windows-stopped-history-handoff-successor-abandoned-observation.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $inputRecord = Read-AgentsChatRetirementJson $Request
    Assert-AgentsChatRetirementFields $inputRecord @(
        'attemptId', 'prepared', 'committed', 'retirement', 'terminal', 'successor', 'successorAbandoned', 'restart'
    )
    . (Join-Path $Source 'windows-stopped-history-handoff-restart-observation.ps1')
    $scope = Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
        $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
        $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart
    $observation = Get-AgentsChatStoppedHistoryHandoffRestartPreparedObservation $scope $ControllerPid $ControllerIdentity
    if ($scope.HistoryHandoffRestartObserver -ne $true -or
        $scope.ContainsKey('HistoryHandoffRestartPreparer') -or
        $scope.ContainsKey('HistoryHandoffRestartPublisher')) {
        throw 'Restart observer gained a preparation or publication role.'
    }
    $mutation = @{
        Context=$scope; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
        AttemptId=[guid]::NewGuid().ToString(); OperationId=[guid]::NewGuid().ToString()
        Token=[guid]::NewGuid().ToString()
        CreatedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    }
    foreach ($case in @(
        @{ name='Get-AgentsChatStoppedHistoryHandoffRestartRecord'; message='Restart preparation requires its independent native role.' },
        @{ name='Publish-AgentsChatStoppedHistoryHandoffRestartPrepared'; message='Restart publication requires its independent native role.' }
    )) {
        $refused = $false
        try { $null = & $case.name @mutation }
        catch {
            if ($_.Exception.Message -cne $case.message) { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Read-only restart observer accepted mutation.' }
    }
    [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 12 -Compress))
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Native restart observation fixture failed: $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Native restart observation fixture cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Restart observation and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
