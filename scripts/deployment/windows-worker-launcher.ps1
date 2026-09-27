param(
    [Parameter(Mandatory)][string]$JobName,
    [Parameter(Mandatory)][int]$OwnerPid,
    [Parameter(Mandatory)][string]$OwnerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$watch = $null
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported native launcher platform.' }
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwner($OwnerPid, $OwnerIdentity)
    [Deployment.WindowsWorkerJob]::JoinCurrent($JobName)
    [Console]::Out.WriteLine((@{
        type='ready'; name=$JobName; pid=$PID
        processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $grant = [Deployment.WindowsWorkerLauncher]::ReadFrame() | ConvertFrom-Json -AsHashtable
    if ($grant.Count -ne 2 -or $grant.type -cne 'run' -or -not $grant.ContainsKey('command')) {
        throw 'Invalid command grant.'
    }
    $command = $grant.command
    if ($command -isnot [System.Collections.IDictionary] -or $command.Count -ne 4) { throw 'Invalid command.' }
    foreach ($key in @('file','args','cwd','env')) {
        if (-not $command.ContainsKey($key)) { throw 'Incomplete command.' }
    }
    if ($command.file -isnot [string] -or $command.cwd -isnot [string] -or $command.args -isnot [array] -or
        $command.env -isnot [System.Collections.IDictionary]) { throw 'Invalid command fields.' }
    foreach ($value in @($command.file, $command.cwd) + $command.args) {
        if ($value -isnot [string] -or $value.Contains([char]0)) { throw 'Invalid command text.' }
    }
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $command.env.GetEnumerator()) {
        if ($entry.Key -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $entry.Value -isnot [string] -or
            $entry.Value.Contains([char]0)) { throw 'Invalid environment.' }
        $environment.Add($entry.Key, $entry.Value)
    }
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($OwnerPid) -cne $OwnerIdentity) { throw 'Owner changed before grant.' }
    $result = [Deployment.WindowsWorkerLauncher]::Run($command.file, [string[]]$command.args, $command.cwd, $environment)
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    [Deployment.WindowsWorkerLauncher]::ReadFrame() | Out-Null
    throw 'Duplicate command grant.'
} catch {
    [Console]::Error.WriteLine('Native Windows launcher failed; no further commands are admitted.')
    exit 1
} finally {
    if ($watch) { $watch.Dispose() }
}
