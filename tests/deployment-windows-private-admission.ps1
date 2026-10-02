param(
    [ValidateSet('suite', 'busy', 'acquire', 'hold')][string]$Case = 'suite',
    [string]$Control
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))
$sources = @((Join-Path $source 'WindowsPrivateFile.cs'))
$partial = Join-Path $source 'WindowsPrivateFile.Admission.cs'
if (Test-Path -LiteralPath $partial) { $sources += $partial }
Add-Type -Path $sources
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
if ($Case -cne 'suite') {
    $lease = $null
    try {
        try { $lease = [Deployment.WindowsPrivateFile]::AcquireAdmission($Control) }
        catch {
            $failure = $_.Exception.GetBaseException()
            if ($Case -ceq 'busy' -and $failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 32) {
                [Console]::WriteLine('busy')
                exit 0
            }
            throw
        }
        Assert ($Case -cne 'busy') 'Independent process acquired an occupied admission'
        $lease.Check()
        [Console]::WriteLine($(if ($Case -ceq 'hold') { 'held' } else { 'acquired' }))
        if ($Case -ceq 'hold') { $null = [Console]::ReadLine() }
    } finally { if ($lease) { $lease.Dispose() } }
    exit 0
}

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WindowsAdmissionFixture
{
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool GetHandleInformation(SafeFileHandle handle, out uint flags);
    public static uint Flags(SafeFileHandle handle)
    {
        uint flags;
        if (!GetHandleInformation(handle, out flags))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return flags;
    }
}
'@
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$scriptFile = $PSCommandPath
$parent = & node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize admission fixture parent'
$control = Join-Path $parent "agents-admission-$([guid]::NewGuid())"
$other = "$control-other"
$moved = "$control-moved"
$lease = $child = $null
function Probe([string]$Mode, [string]$Directory) {
    $reply = & $pwsh -NoProfile -NonInteractive -File $scriptFile -Case $Mode -Control $Directory
    Assert ($LASTEXITCODE -eq 0) 'Independent admission probe failed'
    Assert ($reply -ceq $(if ($Mode -ceq 'busy') { 'busy' } else { 'acquired' })) 'Unexpected admission probe reply'
}
function Refuses([scriptblock]$Action, [string]$Message, [int[]]$Codes = @()) {
    try { & $Action }
    catch {
        $failure = $_.Exception.GetBaseException()
        if ($Codes.Count) {
            $code = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $failure.HResult -band 65535 }
            if ($Codes -notcontains $code) { throw }
        } elseif ($failure.Message -cnotmatch [regex]::Escape($Message)) { throw }
        return
    }
    throw "Expected refusal: $Message"
}
try {
    foreach ($directory in @($control, $other)) {
        $created = [Deployment.WindowsPrivateFile]::CreateDirectory($directory)
        try { $created.Check() } finally { $created.Dispose() }
    }
    Write-Output 'PASS: actual private control directories created before admission'
    $lease = [Deployment.WindowsPrivateFile]::AcquireAdmission($control)
    $lease.Check()
    $gatePath = Join-Path $control 'windows-admission.lock'
    Assert ((Get-Item -LiteralPath $gatePath).Length -eq 0) 'Admission file must remain empty'
    $flags = [Reflection.BindingFlags]'Instance,NonPublic'
    $gate = $lease.GetType().GetField('gate', $flags).GetValue($lease)
    $handle = [Deployment.WindowsPrivateFile].GetField('handle', $flags).GetValue($gate)
    Assert (([WindowsAdmissionFixture]::Flags($handle) -band 1) -eq 0) 'Admission handle must not be inheritable'
    Probe 'busy' $control
    Probe 'acquire' $other
    Refuses { [IO.Directory]::Move($control, $moved) } 'Retained control directory must not move' @(5, 32)
    Refuses { [IO.File]::Move($gatePath, (Join-Path $other 'moved-gate')) } 'Retained gate must not move' @(5, 32)
    $lease.Check()
    $lockDirectory = [Deployment.WindowsPrivateFile]::CreateDirectory((Join-Path $control 'lock'))
    try {
        $owner = [ordered]@{
            version=1; token=[guid]::NewGuid().ToString('D'); project=$other; operationId=[guid]::NewGuid().ToString('D')
            pid=$PID; processIdentity="$PID`:$([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)"
            createdAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        }
        $evidence = [Deployment.WindowsPrivateFile]::Publish(
            (Join-Path $control 'lock/owner.json'), ($owner | ConvertTo-Json -Compress))
        try { $evidenceHash = $evidence.Sha256 } finally { $evidence.Dispose() }
    } finally { $lockDirectory.Dispose() }
    $lease.Dispose()
    $lease.Dispose()
    Refuses { $lease.Check() } 'Windows admission'
    $lease = $null
    Assert (Test-Path -LiteralPath $gatePath) 'Closing admission must not delete its persistent file'
    [IO.Directory]::Move($control, $moved)
    [IO.Directory]::Move($moved, $control)
    Probe 'acquire' $control

    $info = [Diagnostics.ProcessStartInfo]::new($pwsh)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-File', $scriptFile, '-Case', 'hold', '-Control', $control)) {
        $info.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($info)
    $null = $child.Handle
    $ready = $child.StandardOutput.ReadLineAsync()
    Assert ($ready.Wait(15000) -and $ready.GetAwaiter().GetResult() -ceq 'held') 'Fixture owner did not acquire native admission'
    Probe 'busy' $control
    $child.Kill()
    Assert ($child.WaitForExit(15000)) 'Original fixture owner did not exit'
    $child.Dispose()
    $child = $null
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not $lease) {
        try { $lease = [Deployment.WindowsPrivateFile]::AcquireAdmission($control) }
        catch {
            $failure = $_.Exception.GetBaseException()
            if ($failure -isnot [ComponentModel.Win32Exception] -or $failure.NativeErrorCode -ne 32 -or
                $deadline.ElapsedMilliseconds -ge 15000) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    $lease.Check()
    $lease.Dispose()
    $lease = $null
    Write-Output 'PASS: admission excludes independent contenders, separates installations, prevents rename/inheritance and releases after exact owner exit'

    [IO.File]::WriteAllText($gatePath, 'unexpected')
    try {
        Refuses { $unexpected = [Deployment.WindowsPrivateFile]::AcquireAdmission($control); $unexpected.Dispose() } `
            'Private configuration digest differs.'
        Assert ([IO.File]::ReadAllText($gatePath) -ceq 'unexpected') 'Admission changed unsupported existing content'
    } finally { [IO.File]::WriteAllBytes($gatePath, [byte[]]@()) }
    $originalAcl = Get-Acl -LiteralPath $gatePath
    $unsafeAcl = Get-Acl -LiteralPath $gatePath
    $administrators = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    $unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $administrators, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
    try {
        Set-Acl -LiteralPath $gatePath -AclObject $unsafeAcl
        $beforeAcl = (Get-Acl -LiteralPath $gatePath).Sddl
        Refuses { $unexpected = [Deployment.WindowsPrivateFile]::AcquireAdmission($control); $unexpected.Dispose() } `
            'Private configuration permissions are unsupported.'
        Assert ((Get-Acl -LiteralPath $gatePath).Sddl -ceq $beforeAcl) 'Admission repaired unsupported permissions'
    } finally { Set-Acl -LiteralPath $gatePath -AclObject $originalAcl }
    $alias = Join-Path $other 'gate-alias'
    try {
        $null = New-Item -ItemType HardLink -Path $alias -Target $gatePath
        Refuses { $unexpected = [Deployment.WindowsPrivateFile]::AcquireAdmission($control); $unexpected.Dispose() } `
            'Private configuration file type or links are unsupported.'
    } finally { if (Test-Path -LiteralPath $alias) { Remove-Item -LiteralPath $alias } }
    Probe 'acquire' $control
    Assert ((Get-FileHash -LiteralPath (Join-Path $control 'lock/owner.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq
        $evidenceHash) 'Admission release changed original operation evidence'
    Write-Output 'PASS: admission refuses unsafe content, ACLs and hard links without repair or operation-lock removal'
} finally {
    if ($lease) { $lease.Dispose() }
    if ($child) {
        try {
            if (-not $child.HasExited) { $child.Kill() }
            Assert ($child.WaitForExit(15000)) 'Fixture owner cleanup did not settle'
        } finally { $child.Dispose() }
    }
    foreach ($directory in @($control, $other, $moved)) {
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
}
