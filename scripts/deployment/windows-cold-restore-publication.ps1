param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [switch]$FilesRestored
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$watch = $directory = $file = $null
$failure = $null
$stage = 'bootstrap'
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7 -or
        $Control -cnotmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($Control) -cne $Control) {
        throw 'Cold lease publication requires native Windows and canonical control.'
    }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $stage = 'private-directory'
    $destination = Join-Path $Control $(if ($FilesRestored) { 'recovery-lock' } else { 'cold-restore-staging' })
    $directory = if ($FilesRestored) { [Deployment.WindowsPrivateFile]::OpenDirectory($destination) }
        else { [Deployment.WindowsPrivateFile]::CreateDirectory($destination) }
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        directory=$destination
    } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $stage = 'owner-input'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
    $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method', 'record')
    $text = $request.record.GetString()
    if ($request.id.GetInt32() -ne 1 -or $request.method.GetString() -cne 'publish' -or
        [string]::IsNullOrEmpty($text) -or [Text.Encoding]::UTF8.GetByteCount($text) -gt 65536 -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Unexpected cold restore owner publication request.'
    }
    $stage = 'owner-publication'
    $directory.Check()
    $name = if ($FilesRestored) { 'files-restored.json' } else { 'owner.json' }
    $file = [Deployment.WindowsPrivateFile]::Publish((Join-Path $destination $name), $text)
    $directory.Check()
    [Console]::Out.WriteLine((@{ id=1; type='reply'; value=$file.Sha256; processIdentity=$identity } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $stage = 'close'
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
    $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
    if ($request.id.GetInt32() -ne 2 -or $request.method.GetString() -cne 'close' -or
        [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
        throw 'Unexpected cold restore owner publication close.'
    }
    $file.Check()
    $directory.Check()
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Cold restore lease publication refused: $stage.")
} finally {
    foreach ($resource in @($file, $directory, $watch)) {
        if ($resource) {
            try { $resource.Dispose() }
            catch {
                [Console]::Error.WriteLine('Cold restore lease publication cleanup failed.')
                $failure = if ($failure) {
                    [AggregateException]::new('Cold lease publication and cleanup failed.', [Exception[]]@($failure, $_.Exception))
                } else { $_.Exception }
            }
        }
    }
}
if ($failure) { exit 1 }
[Console]::Out.WriteLine((@{ id=2; type='reply'; value='close'; processIdentity=$identity } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
