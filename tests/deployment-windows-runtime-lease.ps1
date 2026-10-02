$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path @('WindowsWorkerJob.cs', 'WindowsPrivateFile.cs', 'WindowsControllerToken.cs',
    'WindowsControllerProcess.cs', 'WindowsRuntimeLease.cs' | ForEach-Object { Join-Path $source $_ })
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$node = (Get-Command node).Source
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize lease fixture directory'
$root = Join-Path $parent "agents-runtime-lease-$([guid]::NewGuid()) space"
[Deployment.WindowsPrivateFile]::CreateDirectory($root).Dispose()
$clients = [Collections.Generic.List[object]]::new()
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('TEMP', $root)
$environment.Add('TMP', $root)
function Receive-Client($Client) {
    $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($Client.Process.StandardOutput, 4096)
    Assert ($read.Wait(15000)) 'Lease fixture client did not reply'
    return $read.GetAwaiter().GetResult() | ConvertFrom-Json
}
function Send-Client($Client, [hashtable]$Request) {
    $Client.Process.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress))
}
function Start-Client([string]$Role, [int]$OwnerPid = 0, [string]$OwnerIdentity = '', [int]$Timeout = 1800000) {
    $arguments = @('-NoProfile', '-NonInteractive', '-File',
        (Join-Path $PSScriptRoot 'deployment-windows-runtime-lease-client.ps1'), '-Role', $Role)
    if ($Role -ceq 'lease') {
        $arguments += @('-OwnerPid', [string]$OwnerPid, '-OwnerIdentity', $OwnerIdentity,
            '-TimeoutMilliseconds', [string]$Timeout)
    }
    $process = [Deployment.WindowsControllerProcess]::Start($pwsh, $arguments, $root, $environment)
    $client = @{ Process=$process; Diagnostic=$process.StandardError.ReadToEndAsync(); Hello=$null }
    $clients.Add($client)
    $client.Hello = Receive-Client $client
    Assert ($client.Hello.pid -eq $process.Id -and
        $client.Hello.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($process.Id)) 'Original lease client identity differs'
    return $client
}
function Exit-Client($Client) {
    Send-Client $Client @{ method='exit' }
    Assert ($Client.Process.WaitForExit(15000) -and $Client.Process.ExitCode -eq 0) 'Fixture client did not exit cleanly'
}
try {
    $owner = Start-Client 'owner'
    foreach ($timeout in @(0, 1800001)) {
        $refused = $false
        try { [Deployment.WindowsRuntimeLease]::Start($owner.Process.Id, $owner.Hello.identity, $timeout).Dispose() }
        catch { $refused = $_.Exception.GetBaseException() -is [ArgumentOutOfRangeException] }
        Assert $refused 'Activation lease accepted an unbounded or empty lifetime'
    }
    $refused = $false
    try { [Deployment.WindowsRuntimeLease]::Start($owner.Process.Id, '1:1', 1800000).Dispose() }
    catch { $refused = $_.Exception.GetBaseException() -is [InvalidOperationException] }
    Assert $refused 'Activation lease adopted a different original controller identity'
    $lease = Start-Client 'lease' $owner.Process.Id $owner.Hello.identity
    Send-Client $lease @{ method='release-lease'; peerPid=$PID }
    Assert ((Receive-Client $lease).value -eq $false) 'Another process released the original controller lease'
    foreach ($attempt in @(1, 2)) {
        Send-Client $lease @{ method='release-lease'; peerPid=$owner.Process.Id }
        Assert ((Receive-Client $lease).value -eq $true) 'Original controller release was not idempotent'
    }
    Exit-Client $owner
    Start-Sleep -Milliseconds 500
    Send-Client $lease @{ method='check' }
    Assert ((Receive-Client $lease).value -ceq 'checked') 'Released lease terminated after original controller exit'
    Send-Client $lease @{ method='release-lease'; peerPid=$owner.Process.Id }
    Assert ((Receive-Client $lease).value -eq $false) 'Exited controller PID authorized another release'
    Exit-Client $lease

    $owner = Start-Client 'owner'
    $lease = Start-Client 'lease' $owner.Process.Id $owner.Hello.identity
    Exit-Client $owner
    Assert ($lease.Process.WaitForExit(15000) -and $lease.Process.ExitCode -eq 1) 'Unreleased lease outlived its original controller'

    $owner = Start-Client 'owner'
    $lease = Start-Client 'lease' $owner.Process.Id $owner.Hello.identity 1000
    Assert ($lease.Process.WaitForExit(5000) -and $lease.Process.ExitCode -eq 1 -and
        -not $owner.Process.HasExited) 'Lease deadline did not independently terminate the guarded process'
    $elapsed = ([Diagnostics.Stopwatch]::GetTimestamp() - [long]$lease.Hello.started) * 1000.0 / [Diagnostics.Stopwatch]::Frequency
    Assert ($elapsed -ge 1000 -and $elapsed -lt 15000) 'Lease lifetime did not honor its measured deadline'
    Exit-Client $owner
    Write-Output 'PASS: original-handle activation lease rejects wrong identity/peer, releases atomically, and bounds owner loss and deadline'
} finally {
    foreach ($client in $clients) {
        try {
            $client.Process.Kill()
            Assert ($client.Process.WaitForExit(15000) -and $client.Diagnostic.Wait(15000)) 'Lease fixture client failed to settle'
            $text = $client.Diagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        } finally { $client.Process.Dispose() }
    }
    Remove-Item -LiteralPath $root -Recurse -Force
}
