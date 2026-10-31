$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'deployment-windows-process-lifetime-helper.ps1')
$current = [Diagnostics.Process]::GetCurrentProcess()
try { $identity = "$PID`:$($current.StartTime.ToUniversalTime().Ticks)" }
finally { $current.Dispose() }
if (-not (Test-WindowsFixtureProcessIdentity $PID $identity)) { throw 'Live original fixture process was reported absent.' }
if (Test-WindowsFixtureProcessIdentity $PID "$PID`:1") { throw 'Foreign process lifetime was reported as the original.' }
foreach ($invalid in @(@{ Id=0; Identity='0:1' }, @{ Id=$PID; Identity='1:1' })) {
    $refused = $false
    try { $null = Test-WindowsFixtureProcessIdentity $invalid.Id $invalid.Identity }
    catch {
        if ($_.Exception.Message -cne 'Fixture process observation requires an original process identity.') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Invalid fixture process identity was accepted.' }
}
$start = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
$start.UseShellExecute = $false
$start.ArgumentList.Add('-e')
$start.ArgumentList.Add('setTimeout(() => {}, 250)')
$child = [Diagnostics.Process]::Start($start)
try {
    $null = $child.Handle
    $childId = $child.Id
    $childIdentity = "$childId`:$($child.StartTime.ToUniversalTime().Ticks)"
    if (-not $child.WaitForExit(15000) -or $child.ExitCode -ne 0) { throw 'Fixture process did not exit normally.' }
    if (Test-WindowsFixtureProcessIdentity $childId $childIdentity) { throw 'Exited retained process was reported alive.' }
} finally {
    if (-not $child.HasExited) {
        $child.Kill()
        if (-not $child.WaitForExit(15000)) { throw 'Fixture process cleanup did not settle.' }
    }
    $child.Dispose()
}
if (Test-WindowsFixtureProcessIdentity $childId $childIdentity) { throw 'Reaped process was reported alive.' }
Write-Output 'PASS: fixture process observation distinguishes live, foreign, exited and reaped lifetimes without treating access failures as absence'
