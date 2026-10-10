param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $watch = $null
$failure = $null
$stage = 'bootstrap'

function Assert-TaskAbsent {
    try { $null = $folder.GetTask($TaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return }
        throw
    }
    throw 'A registered task requires existing-installation inspection.'
}

function Observe-FirstInstallation([bool]$Fresh, [bool]$ControlEvidence) {
    $root.Check()
    Assert-TaskAbsent
    if ($Fresh) {
        foreach ($name in @('.data', '.next', 'node_modules')) {
            if ([IO.Directory]::GetFileSystemEntries($Project, $name).Length -ne 0) {
                throw 'Existing runtime artifacts are not a fresh installation.'
            }
        }
    }
    if ([IO.Directory]::GetFileSystemEntries($parent, $controlName).Length -ne 0) {
        $controlLease = [Deployment.WindowsPrivateFile]::OpenDirectory($control)
        try {
            if ($ControlEvidence -and [IO.Directory]::GetFileSystemEntries($control).Length -ne 0) {
                throw 'Existing deployment evidence requires inspection or recovery.'
            }
            $controlLease.Check()
        } finally { $controlLease.Dispose() }
    }
    Assert-TaskAbsent
    $identity = $root.CaptureIdentity()
    return @{
        status = 'first-install-observed'; runtimeAuthority = $false
        project = $Project; taskName = $TaskName
        accountSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
        dev = $identity.Dev; ino = $identity.Ino
        projectSecurityDescriptor = $root.SecurityDescriptor
    }
}

try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.4' -or
        $TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') {
        throw 'Unsupported first-install inspection context.'
    }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'First-install inspection requires the elevated controller.'
    }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'project'
    $root = [Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project)
    $parent = Split-Path -Parent $Project
    if ([string]::IsNullOrEmpty($parent)) { throw 'A volume root cannot be an installation.' }
    $controlName = ".$(Split-Path -Leaf $Project).deployment"
    $control = Join-Path $parent $controlName
    $stage = 'scheduler'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $stage = 'fresh-installation'
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type = 'ready'; pid = $PID; processIdentity = $identity; controllerIdentity = $ControllerIdentity
        value = (Observe-FirstInstallation $true $true)
    } | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check-fresh', 'check-fresh-runtime', 'check-uninstalled', 'close') -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original first-install observer request differs.'
        }
        $sequence = $id
        $stage = $method
        $value = if ($method -ceq 'close') { 'close' } else {
            Observe-FirstInstallation ($method -cne 'check-uninstalled') ($method -ceq 'check-fresh')
        }
        [Console]::Out.WriteLine((@{ id = $id; type = 'reply'; processIdentity = $identity; value = $value } |
            ConvertTo-Json -Depth 5 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("First-install inspection refused: $stage.")
} finally {
    foreach ($resource in @($root, $watch)) {
        if ($null -eq $resource) { continue }
        try { $resource.Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('First-install inspection and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) {
    [Console]::Error.WriteLine('First-install inspection failed; no installation was authorized.')
    exit 1
}
