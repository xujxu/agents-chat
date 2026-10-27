param(
    [Parameter(Mandatory)][string]$Source,
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
    [Parameter(Mandatory)][string]$PreparedSha256,
    [ValidateSet('Directory', 'Owner', 'Committed')][string]$HoldAt
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
    . (Join-Path $Source 'windows-stopped-history-handoff-commit.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $descriptor = @{
        path="inactive-handoff-$AttemptId-prepared.json"
        dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
    }
    $refused = $false
    try {
        $null = Publish-AgentsChatStoppedHistoryHandoffCommitted $scope $descriptor `
            $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
    } catch {
        if ($_.Exception.Message -cne 'Handoff lock commit requires its independent native role.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Lock commit accepted a scope without its independent role.' }
    $scope.HistoryHandoffLockPublisher = $true
    if ($HoldAt) {
        $directory = New-AgentsChatStoppedHistoryHandoffLock $scope $descriptor `
            $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
        $owner = $committed = $null
        if ($HoldAt -cne 'Directory') { $owner = Publish-AgentsChatStoppedHistoryHandoffLockOwner $scope }
        if ($HoldAt -ceq 'Committed') { $committed = Complete-AgentsChatStoppedHistoryHandoffCommit $scope }
        $null = Assert-AgentsChatStoppedWorkerCleanup $scope
        Assert-AgentsChatStoppedHistoryHandoffLock $scope
        [Console]::Out.WriteLine((@{
            type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            control=$Control; controllerIdentity=$ControllerIdentity
            value=@{ stage=$HoldAt; attemptId=$AttemptId; prepared=$descriptor
                lockIdentity=$directory; owner=$owner; committed=$committed }
        } | ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        $null = [Console]::In.ReadLine()
        throw 'Held native commit fixture received unexpected controller input.'
    }
    $published = Publish-AgentsChatStoppedHistoryHandoffCommitted $scope $descriptor `
        $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
    $document = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $Control $published.path)))
    try {
        $creator = $document.RootElement.GetProperty('creator')
        if ($creator.GetProperty('bridgePid').GetInt32() -ne $PID -or
            $creator.GetProperty('bridgeIdentity').GetString() -cne
                [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
            throw 'Committed receipt does not identify its actual native bridge.'
        }
    } finally { $document.Dispose() }
    [Console]::Out.WriteLine(($published | ConvertTo-Json -Compress))
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Native handoff commit fixture failed: $($failure.Message) $($failure.GetBaseException().Message)")
} finally {
    foreach ($resource in @($scope, $watch)) {
        if ($null -eq $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Native handoff commit fixture cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Native handoff commit fixture and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
