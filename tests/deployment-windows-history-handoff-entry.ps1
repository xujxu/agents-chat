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
    [switch]$Hold,
    [switch]$ObserveRetired,
    [switch]$Abandon,
    [string]$PreparedDev,
    [string]$PreparedIno,
    [int]$PreparedBytes,
    [string]$PreparedSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Hold -and -not $Publish) { throw 'Held preparation requires explicit publication.' }
if ($ObserveRetired -and ($Publish -or $Hold)) { throw 'Retired observation cannot publish preparation.' }
if ($Abandon -and ($Publish -or $Hold -or $ObserveRetired)) { throw 'Abandonment requires its independent fixture branch.' }
Add-Type -Path @(
    'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
    'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
    ForEach-Object { Join-Path $Source $_ })
. (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
. (Join-Path $Source 'windows-stopped-history-handoff-record.ps1')
if ($Publish) { . (Join-Path $Source 'windows-stopped-history-handoff-preparation.ps1') }
if ($ObserveRetired) { . (Join-Path $Source 'windows-stopped-history-handoff-observation.ps1') }
if ($Abandon) { . (Join-Path $Source 'windows-stopped-history-handoff-abandonment.ps1') }
$scope = $watch = $null
try {
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $record = if ($Abandon) {
        $refused = $false
        try {
            $null = Publish-AgentsChatStoppedHistoryHandoffAbandoned $scope @{
                path="inactive-handoff-$AttemptId-prepared.json"
                dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
            } $AttemptId $ControllerPid $ControllerIdentity
        } catch {
            if ($_.Exception.Message -cne 'Abandoned handoff publication requires its independent native role.') { throw }
            $refused = $true
        }
        if (-not $refused) { throw 'Abandonment publication accepted a non-publisher scope.' }
        $scope.HistoryHandoffAbandoner = $true
        $published = Publish-AgentsChatStoppedHistoryHandoffAbandoned $scope @{
            path="inactive-handoff-$AttemptId-prepared.json"
            dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
        } $AttemptId $ControllerPid $ControllerIdentity
        $terminal = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $Control $published.path)))
        try {
            $creator = $terminal.RootElement.GetProperty('creator')
            if ($creator.GetProperty('bridgePid').GetInt32() -ne $PID -or
                $creator.GetProperty('bridgeIdentity').GetString() -cne
                    [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)) {
                throw 'Published abandonment does not identify its actual native bridge.'
            }
        } finally { $terminal.Dispose() }
        $published
    } elseif ($ObserveRetired) {
        Get-AgentsChatStoppedHistoryHandoffRetiredPrepared $scope @{
            path="inactive-handoff-$AttemptId-prepared.json"
            dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
        } $AttemptId $ControllerPid $ControllerIdentity
    } elseif ($Publish) {
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
