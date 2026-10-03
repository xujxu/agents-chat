param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$DestinationParent,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $destination = $watch = $null
$failure = $null
$stage = 'bootstrap'
$junctions = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
function Read-SourceSecurity([string]$Relative, [string]$Kind) {
    $file = $Project
    if ($Relative) {
        if ($Relative.Length -gt 4096 -or $Relative -match '[\\:\x00\r\n]' -or
            @($Relative.Split('/') | Where-Object { -not $_ -or $_ -in @('.', '..') }).Count) {
            throw 'Unsupported snapshot source path.'
        }
        foreach ($part in $Relative.Split('/')) {
            $file = Join-Path $file $part
            if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Snapshot source reparse points are unsupported.'
            }
        }
    }
    $item = Get-Item -LiteralPath $file -Force
    $actualKind = if ($item.PSIsContainer) { 'directory' } else { 'file' }
    $attributes = [int]$item.Attributes
    # These ordinary attributes have standard File.SetAttributes restoration.
    $supported = 1 -bor 2 -bor 4 -bor 16 -bor 32 -bor 128 -bor 8192
    if ($actualKind -cne $Kind -or ($attributes -band (-bnot $supported))) {
        throw 'Snapshot source type or attributes require unsupported native restoration.'
    }
    $acl = Get-Acl -LiteralPath $file
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor
        [Security.AccessControl.AccessControlSections]::Access
    $descriptor = $acl.GetSecurityDescriptorSddlForm($sections)
    if ([Text.Encoding]::UTF8.GetByteCount($descriptor) -gt 8192) { throw 'Snapshot source ACL exceeds its metadata budget.' }
    return @{ securityDescriptor=$descriptor; attributes=$attributes }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported snapshot security observer.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceSecurity.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceReparse.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $stage = 'source-and-private-destination'
    $root = [Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project)
    $destination = [Deployment.WindowsPrivateFile]::OpenDirectory($DestinationParent)
    $metadata = Read-SourceSecurity '' 'directory'
    $root.Check()
    $destination.Check()
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        project=$Project; destinationParent=$DestinationParent; root=$metadata
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    while ($true) {
        $stage = 'request'
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
        $request = Read-AgentsChatMaintenanceFields ($frame.GetAwaiter().GetResult()) @('id', 'method', 'entries')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @('capture', 'close') -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity -or
            $request.entries.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $request.entries.GetArrayLength() -gt 8) {
            throw 'Original snapshot security request differs.'
        }
        $sequence = $id
        $stage = $method
        foreach ($lease in $junctions.Values) { $lease.Check() }
        if ($method -ceq 'close') {
            if ($request.entries.GetArrayLength()) { throw 'Unexpected snapshot close payload.' }
            $value = 'close'
        } else {
            $root.Check()
            $destination.Check()
            $records = @(foreach ($entry in $request.entries.EnumerateArray()) {
                $fields = Read-AgentsChatMaintenanceFields $entry.GetRawText() @('path', 'kind')
                $relative = $fields.path.GetString()
                $kind = $fields.kind.GetString()
                $stage = "${method}:$relative"
                if (-not $relative -or $kind -cnotin @('file', 'directory', 'link')) { throw 'Unsupported snapshot inventory entry.' }
                if ($kind -ceq 'link') {
                    if (-not $junctions.ContainsKey($relative)) {
                        $junctions.Add($relative, [Deployment.WindowsPrivateFile]::OpenSourceReparse($Project, $relative))
                    }
                    $lease = $junctions[$relative]
                    $observed = $lease.Metadata
                    @{ path=$relative; kind=$kind; attributes=$observed.Attributes
                        securityDescriptor=$observed.SecurityDescriptor; data=$lease.ReparseData; linkKind=$lease.Kind }
                } else {
                    $observed = Read-SourceSecurity $relative $kind
                    @{ path=$relative; kind=$kind; attributes=$observed.attributes; securityDescriptor=$observed.securityDescriptor }
                }
            })
            $root.Check()
            $destination.Check()
            $value = @($records)
        }
        $response = @{ id=$id; type='reply'; processIdentity=$identity; value=$value } | ConvertTo-Json -Depth 8 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($response) -ge 131072) { throw 'Snapshot security response exceeds its frame budget.' }
        [Console]::Out.WriteLine($response)
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Snapshot source security observation refused: $stage. $($failure.Message)")
} finally {
    foreach ($resource in (@($junctions.Values) + @($destination, $root, $watch))) {
        if ($null -eq $resource) { continue }
        try { $resource.Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('Snapshot security observation and close failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
