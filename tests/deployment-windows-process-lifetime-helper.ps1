function Test-WindowsFixtureProcessIdentity {
    param([int]$ProcessId, [string]$Identity)
    if ($ProcessId -lt 1 -or $Identity -cnotmatch "^$ProcessId`:[1-9][0-9]*$") {
        throw 'Fixture process observation requires an original process identity.'
    }
    $process = $null
    try {
        try { $process = [Diagnostics.Process]::GetProcessById($ProcessId) }
        catch {
            if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $false }
            throw
        }
        try {
            if ($process.HasExited) { return $false }
            $null = $process.Handle
            return -not $process.HasExited -and
                "$ProcessId`:$($process.StartTime.ToUniversalTime().Ticks)" -ceq $Identity
        } catch {
            if ($_.Exception.GetBaseException() -is [InvalidOperationException] -and $process.HasExited) {
                return $false
            }
            throw
        }
    } finally {
        if ($process) { $process.Dispose() }
    }
}
