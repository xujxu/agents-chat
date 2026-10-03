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
$created = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$removed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$prepared = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$restored = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Read-EntryFields($Entry, [string[]]$Names) {
    $fields = Read-AgentsChatMaintenanceFields $Entry.GetRawText() $Names
    $path = $fields.path.GetString()
    if (-not $path -or $path.Length -gt 4096 -or $path -match '[\\:\x00\r\n<>"|*?]' -or
        @($path.Split('/') | Where-Object {
            -not $_ -or $_ -in @('.', '..') -or $_ -match '[. ]$' -or
            $_ -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])(\.|$)'
        }).Count -or
        $path.Split('/')[0] -iin @('.git', 'logs', '.npm', '.pnpm-store')) {
        throw 'Unsupported project restoration path.'
    }
    return $fields
}
function Check-Roots {
    $root.Check()
    $backupLease.Check()
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported project security restoration.' }
    Add-Type -Path @(
        (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceSecurity.cs'),
        (Join-Path $PSScriptRoot 'WindowsPrivateFile.SourceReparse.cs'))
    . (Join-Path $PSScriptRoot 'windows-task-maintenance.ps1')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $root = [Deployment.WindowsPrivateFile]::OpenSourceDirectory($Project)
    $backupLease = [Deployment.WindowsPrivateFile]::OpenDirectory($Backup)
    [Deployment.WindowsPrivateFile]::CheckSourceRootWriteAccess($Project)
    $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Group -bor
        [Security.AccessControl.AccessControlSections]::Access
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
                'admit-saved', 'admit-current', 'seal', 'prepare', 'begin-removal', 'remove', 'mkdir', 'create', 'junction', 'finish',
                'restore', 'finish-restore', 'check', 'close') -or
            $request.entries.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $request.entries.GetArrayLength() -gt 8 -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original project restoration request differs.'
        }
        $sequence = $id
        $stage = $method
        $entries = @($request.entries.EnumerateArray())
        if ($method -cin @('seal', 'begin-removal', 'finish-restore', 'check', 'close') -and $entries.Count) {
            throw 'Unexpected project restoration control payload.'
        }
        if ($method -cne 'close') { Check-Roots }
        $value = $method
        switch ($method) {
            'admit-saved' {
                if ($phase -cne 'admitting') { throw 'Saved restoration admission is closed.' }
                foreach ($entry in $entries) {
                    $kind = $entry.GetProperty('kind').GetString()
                    $names = @('path', 'kind', 'securityDescriptor', 'attributes', 'bytes')
                    if ($kind -ceq 'link') { $names += 'data' }
                    $fields = Read-EntryFields $entry $names
                    $path = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    $sddl = $fields.securityDescriptor.GetString()
                    $attributes = $fields.attributes.GetUInt32()
                    $bytes = $fields.bytes.GetInt64()
                    $supported = if ($kind -ceq 'link') { 9399 } else { 8375 }
                    if ($kind -cnotin @('file', 'directory', 'link') -or $bytes -lt 0 -or $bytes -gt 9007199254740991 -or
                        $attributes -eq 0 -or (($attributes -band 128) -and $attributes -ne 128) -or
                        ($kind -cne 'file' -and $bytes -ne 0) -or ($attributes -band (-bnot $supported)) -or
                        [bool]($attributes -band 16) -ne ($kind -cne 'file') -or
                        [bool]($attributes -band 1024) -ne ($kind -ceq 'link') -or $saved.Count -ge 250000) {
                        throw 'Unsupported saved source metadata.'
                    }
                    [Deployment.WindowsPrivateFile]::ValidateSourceSecurity($sddl)
                    $data = $null
                    if ($kind -ceq 'link') {
                        $data = $fields.data.GetString()
                        [Deployment.WindowsPrivateFile]::ValidateSourceJunctionData($Project, $data)
                    }
                    $saved.Add($path, @{ Path=$path; Kind=$kind; Security=$sddl; Attributes=$attributes; Bytes=$bytes; Data=$data })
                }
            }
            'admit-current' {
                if ($phase -cne 'admitting') { throw 'Current restoration admission is closed.' }
                foreach ($entry in $entries) {
                    $fields = Read-EntryFields $entry @('path', 'kind')
                    $path = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    if ($current.Count -ge 250000) { throw 'Current project inventory exceeds its budget.' }
                    $data = $null
                    if ($kind -ceq 'link') {
                        $lease = [Deployment.WindowsPrivateFile]::OpenSourceReparseForRemoval($Project, $path)
                        try { $metadata = $lease.Metadata; $data = $lease.ReparseData }
                        finally { $lease.Dispose() }
                    } else {
                        $metadata = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $path, $kind)
                    }
                    $current.Add($path, @{ Path=$path; Kind=$kind; Metadata=$metadata; Data=$data })
                }
            }
            'seal' {
                if ($phase -cne 'admitting') { throw 'Project restoration was already admitted.' }
                $phase = 'admitted'
            }
            'prepare' {
                if ($phase -cne 'admitted') { throw 'Project removal requires original admission.' }
                foreach ($item in $entries) {
                    $fields = Read-EntryFields $item @('path')
                    $path = $fields.path.GetString()
                    if (-not $current.ContainsKey($path) -or $current[$path].Kind -cne 'directory' -or $prepared.Contains($path)) {
                        throw 'Directory removal preparation is not admitted.'
                    }
                    $entry = $current[$path]
                    [Deployment.WindowsPrivateFile]::PrepareSourceDirectoryRemoval(
                        $Project, $entry.Path, $entry.Metadata.Dev, $entry.Metadata.Ino)
                    [void]$prepared.Add($path)
                }
            }
            'begin-removal' {
                if ($phase -cne 'admitted' -or $prepared.Count -ne @($current.Values | Where-Object { $_.Kind -ceq 'directory' }).Count) {
                    throw 'Directory removal preparation is incomplete.'
                }
                $phase = 'removing'
            }
            'remove' {
                if ($phase -cne 'removing') { throw 'Project removal is closed.' }
                foreach ($entry in $entries) {
                    $fields = Read-EntryFields $entry @('path')
                    $path = $fields.path.GetString()
                    if (-not $current.ContainsKey($path) -or $removed.Contains($path)) { throw 'Removal is not originally admitted.' }
                    $original = $current[$path]
                    if ($original.Kind -ceq 'link') {
                        [Deployment.WindowsPrivateFile]::RemoveSourceJunction(
                            $Project, $path, $original.Metadata.Dev, $original.Metadata.Ino, $original.Data)
                    } else {
                        [Deployment.WindowsPrivateFile]::RemoveSourceEntry(
                            $Project, $path, $original.Kind, $original.Metadata.Dev, $original.Metadata.Ino)
                    }
                    [void]$removed.Add($path)
                }
            }
            { $_ -cin @('mkdir', 'create', 'junction') } {
                if ($phase -cnotin @('removing', 'creating') -or $removed.Count -ne $current.Count) {
                    throw 'Private restoration creation requires completed original removal.'
                }
                $phase = 'creating'
                foreach ($entry in $entries) {
                    $fields = Read-EntryFields $entry @('path')
                    $path = $fields.path.GetString()
                    $kind = if ($method -ceq 'mkdir') { 'directory' } elseif ($method -ceq 'junction') { 'link' } else { 'file' }
                    if (-not $saved.ContainsKey($path) -or $saved[$path].Kind -cne $kind -or $created.ContainsKey($path)) {
                        throw 'Private restoration creation is not admitted.'
                    }
                    $lease = if ($kind -ceq 'directory') {
                        [Deployment.WindowsPrivateFile]::CreateSourceDirectory($Project, $path)
                    } elseif ($kind -ceq 'link') {
                        if (@($saved.Values | Where-Object {
                            $_.Kind -cne 'link' -and (-not $created.ContainsKey($_.Path) -or -not $created[$_.Path].Finished)
                        }).Count) { throw 'Junction creation requires all ordinary payloads.' }
                        $original = $saved[$path]
                        [Deployment.WindowsPrivateFile]::CreateSourceJunction(
                            $Project, $path, $original.Data, $original.Security, $original.Attributes)
                    } else { [Deployment.WindowsPrivateFile]::CreateSourceFile($Project, $path) }
                    $created.Add($path, @{ Lease=$lease; Metadata=$null; Finished=($kind -cne 'file') })
                    $created[$path].Metadata = if ($kind -ceq 'directory') {
                        [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $path, $kind)
                    } elseif ($kind -ceq 'link') {
                        $lease.Metadata
                    } else { $lease.CaptureIdentity() }
                }
            }
            'finish' {
                if ($phase -cne 'creating') { throw 'Private file writes are closed.' }
                foreach ($entry in $entries) {
                    $fields = Read-EntryFields $entry @('path')
                    $path = $fields.path.GetString()
                    if (-not $created.ContainsKey($path) -or $created[$path].Finished -or $saved[$path].Kind -cne 'file') {
                        throw 'Private file completion is not admitted.'
                    }
                    $item = $created[$path]
                    $item.Metadata = $item.Lease.Finish($saved[$path].Bytes)
                    $item.Lease.Dispose()
                    $item.Lease = $null
                    $item.Finished = $true
                }
            }
            'restore' {
                if ($phase -cnotin @('removing', 'creating', 'restoring')) { throw 'Source policy restoration is closed.' }
                if ($phase -cne 'restoring') {
                    if ($removed.Count -ne $current.Count -or $created.Count -ne $saved.Count -or
                        @($created.Values | Where-Object { -not $_.Finished }).Count) {
                        throw 'Source policy restoration requires all original private copies.'
                    }
                    foreach ($item in $created.Values) {
                        if ($item.Lease) { $item.Lease.Dispose(); $item.Lease = $null }
                    }
                    $phase = 'restoring'
                }
                foreach ($item in $entries) {
                    $fields = Read-EntryFields $item @('path')
                    $path = $fields.path.GetString()
                    if (-not $saved.ContainsKey($path) -or $restored.Contains($path)) { throw 'Restored source policy is not admitted.' }
                    $entry = $saved[$path]
                    Check-Roots
                    $metadata = $created[$entry.Path].Metadata
                    if ($entry.Kind -ceq 'link') {
                        if (@($saved.Values | Where-Object { $_.Kind -cne 'link' -and -not $restored.Contains($_.Path) }).Count) {
                            throw 'Junction policy requires completed ordinary source policies.'
                        }
                        [Deployment.WindowsPrivateFile]::RestoreSourceJunctionSecurity($Project, $entry.Path,
                            $metadata.Dev, $metadata.Ino, $entry.Data, $entry.Security, $entry.Attributes)
                    } else {
                        [Deployment.WindowsPrivateFile]::RestoreSourceSecurity($Project, $entry.Path, $entry.Kind,
                            $metadata.Dev, $metadata.Ino, $entry.Security, $entry.Attributes)
                    }
                    [void]$restored.Add($path)
                }
            }
            'finish-restore' {
                if ($phase -cnotin @('restoring', 'removing') -or $restored.Count -ne $saved.Count -or
                    $removed.Count -ne $current.Count) {
                    throw 'Source security restoration is incomplete.'
                }
                $phase = 'restored'
            }
        }
        if ($method -cne 'close') { Check-Roots }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$value } |
            ConvertTo-Json -Depth 8 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_.Exception
    [Console]::Error.WriteLine("Project security restoration refused: $stage. $($failure.Message)")
    for ($cause = $failure; $null -ne $cause; $cause = $cause.InnerException) {
        if ($cause -is [ComponentModel.Win32Exception]) {
            [Console]::Error.WriteLine("Native restoration error code: $($cause.NativeErrorCode).")
        }
    }
} finally {
    $resources = @($created.Values | ForEach-Object { $_.Lease }) + @($backupLease, $root, $watch)
    foreach ($resource in $resources) {
        if ($null -eq $resource) { continue }
        try { $resource.Dispose() }
        catch {
            $failure = if ($failure) {
                [AggregateException]::new('Project security restoration and cleanup failed.', [Exception[]]@($failure, $_.Exception))
            } else { $_.Exception }
        }
    }
}
if ($failure) { exit 1 }
