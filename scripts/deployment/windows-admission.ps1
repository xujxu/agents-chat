param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$lease = $watch = $null
$stage = 'bootstrap'
$failure = $null
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported bridge platform.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.Admission.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $stage = 'controller'
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'acquire'
    $lease = [Deployment.WindowsPrivateFile]::AcquireAdmission($Control)
    $lease.Check()
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close')) { throw 'Invalid admission request.' }
        $sequence = $id
        $stage = 'check'
        if ([Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original admission controller changed.'
        }
        $lease.Check()
        if ($method -ceq 'close') {
            $stage = 'close'
            $lease.Dispose()
            $lease = $null
        }
        [Console]::Out.WriteLine((@{
            id=$id; type='reply'; value=$method
            processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    $native = $failure.GetBaseException()
    if ($stage -ceq 'acquire' -and $native -is [ComponentModel.Win32Exception] -and $native.NativeErrorCode -eq 32) {
        $stage = 'acquire/busy'
    }
    [Console]::Error.WriteLine("Windows admission refused: $stage.")
} finally {
    foreach ($retained in @($lease, $watch)) {
        if ($retained) {
            try { $retained.Dispose() }
            catch {
                [Console]::Error.WriteLine('Windows admission cleanup failed.')
                $failure = if ($failure) {
                    [AggregateException]::new('Admission and cleanup failed.', [Exception[]]@($failure, $_.Exception))
                } else { $_.Exception }
            }
        }
    }
}
if ($failure) { exit 1 }
