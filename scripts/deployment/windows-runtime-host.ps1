param(
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or
        [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Managed runtime startup refused: bootstrap.'
    }
    $files = @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
        'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsRuntimeHost.cs')
    Add-Type -Path @($files | ForEach-Object { Join-Path $PSScriptRoot $_ })
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { $pwsh = $process.MainModule.FileName }
    finally { $process.Dispose() }
    [Deployment.WindowsRuntimeHost]::Run($Configuration, $Sha256, $PSScriptRoot, $pwsh)
} catch {
    $message = $_.Exception.GetBaseException().Message
    if ($message -cnotmatch '^Managed runtime startup refused: [a-z-]+\.$') {
        $message = 'Managed runtime startup refused: bootstrap.'
    }
    [Console]::Error.WriteLine($message)
    exit 1
}
