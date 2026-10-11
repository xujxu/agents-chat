[CmdletBinding(DefaultParameterSetName = 'Installed')]
param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory, ParameterSetName = 'Installed')][string]$Configuration,
    [Parameter(Mandatory, ParameterSetName = 'Installed')][string]$Sha256,
    [Parameter(Mandatory, ParameterSetName = 'Fresh')][switch]$FreshInstallation,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$files = [Collections.Generic.List[IDisposable]]::new()
$entries = [Collections.Generic.List[object]]::new()
$watch = $root = $null
$failure = $null
$stage = 'bootstrap'
function Test-ConfigurationEntry([string]$Path) {
    $name = [IO.Path]::GetFileName($Path)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Project, $name)) {
        if (-not [string]::Equals([IO.Path]::GetFileName($entry), $name, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Configuration source name is ambiguous.'
        }
        return $true
    }
    return $false
}
function Observe-Configuration {
    foreach ($file in $files) { $file.Check() }
    $records = foreach ($entry in $entries) {
        if ($null -eq $entry.File) {
            if (Test-ConfigurationEntry $entry.Path) { throw 'Previously absent configuration appeared.' }
            [pscustomobject]@{
                path=$entry.Path; present=$false; sha256=$null; bytes=$null
                dev=$null; ino=$null; securityDescriptor=$null
            }
        } else {
            $identity = $entry.File.CaptureIdentity()
            [pscustomobject]@{
                path=$entry.Path; present=$true; sha256=$entry.File.Sha256; bytes=$entry.File.ByteLength
                dev=$identity.Dev; ino=$identity.Ino; securityDescriptor=$entry.File.SecurityDescriptor
            }
        }
    }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor
        [Security.AccessControl.AccessControlSections]::Access
    $projectFileSecurity = (Get-Acl -LiteralPath $Project).GetSecurityDescriptorSddlForm($sections)
    foreach ($file in $files) { $file.Check() }
    return [pscustomobject]@{
        project=$Project
        configuration=$(if ($FreshInstallation) { $null } else { $Configuration })
        configurationSha256=$(if ($FreshInstallation) { $null } else { $Sha256 })
        projectSecurityDescriptor=$root.SecurityDescriptor
        projectFileSecurityDescriptor=$projectFileSecurity; files=@($records)
    }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported configuration observer.' }
    Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'project'
    $root = [Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project)
    $files.Add($root)
    if (-not $FreshInstallation) {
        $stage = 'installed-configuration'
        if ([IO.Path]::GetFileName($Configuration) -cne 'configuration.json') { throw 'Unsupported installed configuration path.' }
        $files.Add([Deployment.WindowsPrivateFile]::OpenDirectory([IO.Path]::GetDirectoryName($Configuration)))
        $installed = [Deployment.WindowsPrivateFile]::Open($Configuration, $Sha256)
        $files.Add($installed)
        $document = [Text.Json.JsonDocument]::Parse($installed.ReadText())
        try {
            if ($document.RootElement.GetProperty('command').GetProperty('cwd').GetString() -cne $Project) {
                throw 'Installed configuration project differs.'
            }
        } finally { $document.Dispose() }
    }
    foreach ($name in @('.env.production.local', '.env.local', '.env.production', '.env', 'agents.json')) {
        $stage = $name
        $path = Join-Path $Project $name
        $file = $null
        if (Test-ConfigurationEntry $path) {
            $item = Get-Item -LiteralPath $path -Force
            if ($item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Encrypted)) {
                throw 'Configuration source is not an ordinary file.'
            }
            if ($item.Length -gt 1048576) { throw 'Configuration source exceeds its byte limit.' }
            $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            $file = [Deployment.WindowsPrivateFile]::OpenSourceFile($path, $digest)
            $files.Add($file)
        }
        $entries.Add(@{ Path=$path; File=$file })
    }
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        value=(Observe-Configuration)
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
        $request = Read-AgentsChatMaintenanceFields ($line.GetAwaiter().GetResult()) @('id', 'method')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('check', 'close') -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original configuration observer request differs.'
        }
        $sequence = $id
        $stage = $method
        $value = if ($method -ceq 'close') { 'close' } else { Observe-Configuration }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Configuration file observation refused: $stage. $($failure.Message)")
} finally {
    for ($index = $files.Count - 1; $index -ge 0; $index--) {
        try { $files[$index].Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('Configuration observation and close failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
    if ($watch) {
        try { $watch.Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('Configuration observer lifetime cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) {
    [Console]::Error.WriteLine('Configuration observation failed; retain original files and permissions.')
    exit 1
}
