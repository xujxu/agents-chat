param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$OwnerSha256,
    [Parameter(Mandatory)][string]$ReceiptSha256,
    [Parameter(Mandatory)][string]$IntentSha256,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$context = $watch = $null
$failure = $null
$sequence = 0
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
        @(@($OwnerSha256, $ReceiptSha256, $IntentSha256) | Where-Object { $_ -cnotmatch '^[a-f0-9]{64}$' }).Count) {
        throw 'Unsupported cold activation platform or evidence digests.'
    }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeDomain.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimePipe.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeControl.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsRuntimeLease.cs'),
        (Join-Path $PSScriptRoot 'WindowsRuntimeHost.cs'))
    . (Join-Path $PSScriptRoot 'windows-cold-activation-context.ps1')
    . (Join-Path $PSScriptRoot 'windows-cold-activation-runtime.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $context = Open-AgentsChatColdActivationContext -Control $Control -OwnerSha256 $OwnerSha256 `
        -ReceiptSha256 $ReceiptSha256 -IntentSha256 $IntentSha256 `
        -ControllerPid $ControllerPid -ControllerIdentity $ControllerIdentity
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$context.Identity; controllerIdentity=$ControllerIdentity
        control=$Control; ownerSha256=$OwnerSha256; receiptSha256=$ReceiptSha256; intentSha256=$IntentSha256
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    while ($true) {
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $sequence++
        $method = $request.method.GetString()
        if ($request.id.GetInt32() -ne $sequence -or $method -cnotin @('start', 'check', 'close')) {
            throw 'Unexpected cold activation request.'
        }
        if ($method -ceq 'close') { break }
        $value = if ($method -ceq 'start') { Start-AgentsChatColdActivatedRuntime $context }
            else { Assert-AgentsChatColdActivatedRuntime $context }
        [Console]::Out.WriteLine((@{
            id=$sequence; type='reply'; processIdentity=$context.Identity; value=$value
        } | ConvertTo-Json -Depth 6 -Compress))
        [Console]::Out.Flush()
    }
} catch {
    $failure = $_.Exception
    $stage = if ($context) { $context.Stage } else { 'admission' }
    [Console]::Error.WriteLine("Cold guarded activation refused: $stage. $($failure.GetBaseException().Message)")
} finally {
    if ($context) {
        try { Stop-AgentsChatColdActivatedRuntime $context }
        catch {
            [Console]::Error.WriteLine("Cold guarded runtime settlement failed: $($_.Exception.GetBaseException().Message)")
            $failure = if ($failure) {
                [AggregateException]::new('Cold activation and settlement failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    $resources = if ($context) { @($context.Proof, $context.Owner, $watch) } else { @($watch) }
    foreach ($resource in $resources) {
        if (-not $resource) { continue }
        try {
            if ($resource -is [hashtable]) { Close-AgentsChatTaskCompletionProof $resource }
            else { $resource.Dispose() }
        } catch {
            [Console]::Error.WriteLine('Cold guarded activation resource cleanup failed.')
            $failure = if ($failure) {
                [AggregateException]::new('Cold activation and resource cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
[Console]::Out.WriteLine((@{
    id=$sequence; type='reply'; processIdentity=$context.Identity; value='close'
} | ConvertTo-Json -Compress))
[Console]::Out.Flush()
