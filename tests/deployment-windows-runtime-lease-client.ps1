param(
    [Parameter(Mandatory)][ValidateSet('owner', 'lease')][string]$Role,
    [int]$OwnerPid,
    [string]$OwnerIdentity,
    [int]$TimeoutMilliseconds = 1800000
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsRuntimeLease.cs' | ForEach-Object { Join-Path $source $_ })
$lease = $null
try {
    $started = [Diagnostics.Stopwatch]::GetTimestamp()
    if ($Role -ceq 'lease') {
        $lease = [Deployment.WindowsRuntimeLease]::Start($OwnerPid, $OwnerIdentity, $TimeoutMilliseconds)
    }
    [Console]::Out.WriteLine((@{
        pid=$PID; identity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID); started=$started
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    while ($true) {
        $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        if (-not $read.Wait(60000)) { throw 'Fixture controller request timed out.' }
        $request = $read.GetAwaiter().GetResult() | ConvertFrom-Json
        $value = switch ($request.method) {
            'check' {
                if (-not $lease) { throw 'Fixture lease is absent.' }
                $lease.Check()
                'checked'
            }
            'release-lease' {
                if (-not $lease) { throw 'Fixture lease is absent.' }
                $lease.TryRelease([int]$request.peerPid)
            }
            'release-runtime' {
                [Deployment.WindowsRuntimeControl]::Exchange([guid]$request.generation,
                    [int]$request.ownerPid, [string]$request.ownerIdentity, 'release', 15000)
            }
            'exit' { return }
            default { throw 'Unknown fixture controller request.' }
        }
        [Console]::Out.WriteLine((@{ value=$value } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
} finally { if ($lease) { $lease.Dispose() } }
