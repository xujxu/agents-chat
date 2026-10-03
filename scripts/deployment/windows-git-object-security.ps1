param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Backup,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $backupLease = $watch = $null
$failure = $null
$stage = 'bootstrap'
$saved = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$current = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$stages = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$policies = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$directoryLeases = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$restored = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$suffix = '.agents-chat-restore'
function Read-EntryFields($Entry, [string[]]$Names) {
    $fields = Read-AgentsChatMaintenanceFields $Entry.GetRawText() $Names
    $path = $fields.path.GetString()
    if (-not $path -or $path.Length -gt 4096 -or $path -cnotmatch
        '^(info(?:/commit-graphs)?|pack|[a-f0-9]{2}|(?:[a-f0-9]{2}/(?:[a-f0-9]{38}|[a-f0-9]{62})|pack/pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:pack|idx|rev|bitmap)|info/commit-graphs/graph-(?:[a-f0-9]{40}|[a-f0-9]{64})\.graph)(?:\.agents-chat-restore)?)$') {
        throw 'Unsupported immutable Git object restoration path.'
    }
    return $fields
}
function Check-Roots {
    $root.Check()
    $backupLease.Check()
    foreach ($lease in $directoryLeases.Values) { $lease.Check() }
}
function Get-Stage([string]$Path) {
    if (-not $stages.ContainsKey($Path)) {
        $name = $Path + $suffix
        if (-not $current.ContainsKey($name) -or $current[$name].Kind -cne 'file') {
            throw 'Original Git stage is not admitted.'
        }
        $stages.Add($Path, @{ Metadata=$current[$name]; Lease=$null; Finished=$true; Policy=$false; Removed=$false })
    }
    return $stages[$Path]
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported Git object security restoration.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceSecurity.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $root = [Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project)
    $backupLease = [Deployment.WindowsPrivateFile]::OpenDirectory($Backup)
    [Deployment.WindowsPrivateFile]::CheckSourceRootWriteAccess($Project)
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
    $rootPolicy = (Get-Acl -LiteralPath $Project).GetSecurityDescriptorSddlForm($sections)
    Check-Roots
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        project=$Project; backup=$Backup
        root=@{ securityDescriptor=$rootPolicy; attributes=[int](Get-Item -LiteralPath $Project -Force).Attributes }
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $sequence = 0
    $phase = 'admitting'
    while ($true) {
        $stage = 'request'
        $frame = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
        $request = Read-AgentsChatMaintenanceFields ($frame.GetAwaiter().GetResult()) @('id', 'method', 'entries')
        $id = $request.id.GetInt32()
        $method = $request.method.GetString()
        if ($id -ne $sequence + 1 -or $method -cnotin @(
                'admit-saved', 'admit-current', 'seal', 'directory', 'create-stage', 'finish-stage',
                'stage-policy', 'remove-stage', 'target-policy', 'complete', 'check', 'close') -or
            $request.entries.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $request.entries.GetArrayLength() -gt 8 -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original Git object restoration request differs.'
        }
        $sequence = $id
        $stage = $method
        $entries = @($request.entries.EnumerateArray())
        if ($method -cin @('seal', 'complete', 'check', 'close')) {
            if ($entries.Count) { throw 'Unexpected Git object control payload.' }
        } elseif ($method -cnotin @('admit-saved', 'admit-current')) {
            if ($phase -cne 'restoring' -or $entries.Count -ne 1) { throw 'Git object mutation is not admitted.' }
        }
        if ($method -cne 'close') { Check-Roots }
        switch ($method) {
            'admit-saved' {
                if ($phase -cne 'admitting') { throw 'Saved Git admission is closed.' }
                foreach ($item in $entries) {
                    $fields = Read-EntryFields $item @('path', 'kind', 'securityDescriptor', 'attributes', 'bytes')
                    $path = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    $sddl = $fields.securityDescriptor.GetString()
                    $attributes = $fields.attributes.GetUInt32()
                    $bytes = $fields.bytes.GetInt64()
                    $isDirectory = $path -cmatch '^(info(?:/commit-graphs)?|pack|[a-f0-9]{2})$'
                    if ($path.EndsWith($suffix, [StringComparison]::Ordinal) -or
                        $kind -cnotin @('file', 'directory') -or $isDirectory -ne ($kind -ceq 'directory') -or
                        $bytes -lt 0 -or $bytes -gt 9007199254740991 -or ($isDirectory -and $bytes -ne 0) -or
                        $attributes -eq 0 -or (($attributes -band 128) -and $attributes -ne 128) -or
                        ($attributes -band (-bnot 8375)) -or [bool]($attributes -band 16) -ne $isDirectory -or
                        $saved.Count -ge 250000) { throw 'Unsupported saved Git object metadata.' }
                    if (-not $policies.ContainsKey($sddl)) {
                        [Deployment.WindowsPrivateFile]::ValidateSourceSecurity($sddl)
                        $policies.Add($sddl, $sddl)
                    }
                    $saved.Add($path, @{ Path=$path; Kind=$kind; Security=$policies[$sddl]; Attributes=$attributes; Bytes=$bytes })
                }
            }
            'admit-current' {
                if ($phase -cne 'admitting') { throw 'Current Git admission is closed.' }
                foreach ($item in $entries) {
                    $fields = Read-EntryFields $item @('path', 'kind')
                    $path = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    if ($current.Count -ge 250000 -or
                        ($path.EndsWith($suffix, [StringComparison]::Ordinal) -and
                            -not $saved.ContainsKey($path.Substring(0, $path.Length - $suffix.Length)))) {
                        throw 'Current Git object inventory is not admitted.'
                    }
                    $metadata = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $path, $kind)
                    $current.Add($path, @{ Kind=$kind; Dev=$metadata.Dev; Ino=$metadata.Ino })
                }
            }
            'seal' {
                if ($phase -cne 'admitting') { throw 'Git object restoration was already admitted.' }
                $directoryCount = @($saved.Values | Where-Object { $_.Kind -ceq 'directory' }).Count
                $fileCount = $saved.Count - $directoryCount
                $phase = 'restoring'
            }
            'directory' {
                $fields = Read-EntryFields $entries[0] @('path')
                $path = $fields.path.GetString()
                if (-not $saved.ContainsKey($path) -or $saved[$path].Kind -cne 'directory' -or $directories.Contains($path)) {
                    throw 'Git directory policy is not admitted.'
                }
                $entry = $saved[$path]
                if ($current.ContainsKey($path)) {
                    if ($current[$path].Kind -cne 'directory') { throw 'Git directory type differs.' }
                    $metadata = $current[$path]
                } else {
                    $lease = [Deployment.WindowsPrivateFile]::CreateSourceDirectory($Project, $path)
                    try { $metadata = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $path, 'directory') }
                    finally { $lease.Dispose() }
                }
                [Deployment.WindowsPrivateFile]::RestoreSourceSecurity(
                    $Project, $path, 'directory', $metadata.Dev, $metadata.Ino, $entry.Security, $entry.Attributes)
                $guard = [Deployment.WindowsPrivateFile]::OpenSourceDirectory((Join-Path $Project $path))
                $directoryLeases.Add($path, $guard)
                $identityAfter = $guard.CaptureIdentity()
                if ($identityAfter.Dev -cne $metadata.Dev -or $identityAfter.Ino -cne $metadata.Ino) {
                    throw 'Restored Git directory identity changed before retention.'
                }
                [void]$directories.Add($path)
            }
            { $_ -cin @('create-stage', 'finish-stage', 'stage-policy', 'remove-stage', 'target-policy') } {
                $fields = Read-EntryFields $entries[0] @('path')
                $path = $fields.path.GetString()
                if ($directories.Count -ne $directoryCount -or -not $saved.ContainsKey($path) -or
                    $saved[$path].Kind -cne 'file' -or $restored.Contains($path)) { throw 'Git file restoration is not admitted.' }
                $entry = $saved[$path]
                $name = $path + $suffix
                switch ($method) {
                    'create-stage' {
                        if ($current.ContainsKey($path) -or $current.ContainsKey($name) -or $stages.ContainsKey($path)) {
                            throw 'Git stage creation conflicts with original evidence.'
                        }
                        $lease = [Deployment.WindowsPrivateFile]::CreateSourceFile($Project, $name)
                        $stages.Add($path, @{ Metadata=$null; Lease=$lease; Finished=$false; Policy=$false; Removed=$false })
                        $stages[$path].Metadata = $lease.CaptureIdentity()
                    }
                    'finish-stage' {
                        $item = Get-Stage $path
                        if ($item.Finished -or -not $item.Lease) { throw 'Git private stage is already finished.' }
                        $item.Metadata = $item.Lease.Finish($entry.Bytes)
                        $item.Lease.Dispose()
                        $item.Lease = $null
                        $item.Finished = $true
                    }
                    'stage-policy' {
                        $item = Get-Stage $path
                        if (-not $item.Finished -or $item.Policy -or $item.Removed) { throw 'Git stage policy is not ready.' }
                        [Deployment.WindowsPrivateFile]::RestoreSourceSecurity(
                            $Project, $name, 'file', $item.Metadata.Dev, $item.Metadata.Ino, $entry.Security, $entry.Attributes)
                        $item.Policy = $true
                    }
                    'remove-stage' {
                        $item = Get-Stage $path
                        if (-not $item.Finished -or $item.Removed) { throw 'Git stage retirement is not ready.' }
                        $target = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $path, 'file')
                        if ($target.Dev -cne $item.Metadata.Dev -or $target.Ino -cne $item.Metadata.Ino) {
                            throw 'Git stage and published object identities differ.'
                        }
                        [Deployment.WindowsPrivateFile]::RemoveSourceEntry(
                            $Project, $name, 'file', $item.Metadata.Dev, $item.Metadata.Ino)
                        $item.Removed = $true
                    }
                    'target-policy' {
                        if (($stages.ContainsKey($path) -and -not $stages[$path].Removed) -or
                            ($current.ContainsKey($name) -and -not $stages.ContainsKey($path))) {
                            throw 'Git stage retirement is incomplete.'
                        }
                        $metadata = if ($current.ContainsKey($path)) { $current[$path] }
                            elseif ($stages.ContainsKey($path) -and $stages[$path].Removed) { $stages[$path].Metadata }
                            else { throw 'Published Git object is not originally admitted.' }
                        [Deployment.WindowsPrivateFile]::RestoreSourceSecurity(
                            $Project, $path, 'file', $metadata.Dev, $metadata.Ino, $entry.Security, $entry.Attributes)
                        [void]$restored.Add($path)
                    }
                }
            }
            'complete' {
                if ($phase -cne 'restoring' -or $directories.Count -ne $directoryCount -or $restored.Count -ne $fileCount) {
                    throw 'Git object security restoration is incomplete.'
                }
                $phase = 'complete'
            }
        }
        if ($method -cne 'close') { Check-Roots }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$method } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Git object security restoration refused: $stage. $($failure.Message)")
    for ($cause = $failure; $null -ne $cause; $cause = $cause.InnerException) {
        if ($cause -is [ComponentModel.Win32Exception]) {
            [Console]::Error.WriteLine("Native Git restoration error code: $($cause.NativeErrorCode).")
        }
    }
} finally {
    foreach ($resource in (@($stages.Values | ForEach-Object { $_.Lease }) +
        @($directoryLeases.Values) + @($backupLease, $root, $watch))) {
        if ($null -eq $resource) { continue }
        try { $resource.Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('Git object restoration and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
