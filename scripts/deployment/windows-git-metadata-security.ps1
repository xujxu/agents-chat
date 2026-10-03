param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Backup,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $backupLease = $watch = $proof = $null
$proofHash = $null
$failure = $null
$stage = 'bootstrap'
$saved = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$allowed = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$directories = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$stages = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
$guardName = 'agents-chat-restore'
$proofName = 'agents-chat-restore/intent.json'
$guardPath = [IO.Path]::Combine($Project, $guardName)
$proofPath = [IO.Path]::Combine($Project, $proofName.Replace('/', '\'))
function Check-Roots {
    $root.Check()
    $backupLease.Check()
    foreach ($lease in $directories.Values) { $lease.Check() }
    if ($proof) { $proof.Check() }
}
function Read-Path($Item, [string[]]$Names = @('path')) {
    $fields = Read-AgentsChatMaintenanceFields $Item.GetRawText() $Names
    $name = $fields.path.GetString()
    if ($name -cne '' -and -not $allowed.ContainsKey($name)) { throw 'Git metadata path is not admitted.' }
    return $fields
}
function Capture([string]$Name) {
    if ($Name -ceq '') {
        $id = $root.CaptureIdentity()
        return @{
            path=''; dev=$id.Dev; ino=$id.Ino; bytes=0
            windowsSecurity=@{ securityDescriptor=$root.SecurityDescriptor; attributes=[int](Get-Item -LiteralPath $Project -Force).Attributes }
        }
    }
    $kind = $allowed[$Name]
    $value = [Deployment.WindowsPrivateFile]::CaptureOptionalSourceSecurity($Project, $Name, $kind)
    if (-not $value) { return $null }
    if ($kind -ceq 'directory' -and -not $directories.ContainsKey($Name)) {
        $file = [IO.Path]::Combine($Project, $Name.Replace('/', '\'))
        $lease = if ($Name -ceq $guardName) {
            [Deployment.WindowsPrivateFile]::OpenDirectory($file)
        } else { [Deployment.WindowsPrivateFile]::OpenSourceDirectory($file) }
        $directories.Add($Name, $lease)
        $id = $lease.CaptureIdentity()
        if ($id.Dev -cne $value.Dev -or $id.Ino -cne $value.Ino) { throw 'Git directory changed before retention.' }
    }
    return @{
        path=$Name; dev=$value.Dev; ino=$value.Ino; bytes=$value.Bytes
        windowsSecurity=@{ securityDescriptor=$value.SecurityDescriptor; attributes=$value.Attributes }
    }
}
function Apply-Policy([string]$Name, [string]$Target, $Identity) {
    $entry = $saved[$Name]
    if ($entry.Inherit) {
        [Deployment.WindowsPrivateFile]::InheritSourceSecurity($Project, $Target, $entry.Kind, $Identity.Dev, $Identity.Ino)
    } else {
        [Deployment.WindowsPrivateFile]::RestoreSourceSecurity(
            $Project, $Target, $entry.Kind, $Identity.Dev, $Identity.Ino, $entry.Security, $entry.Attributes)
    }
}
function Match-File($Expected, $Actual) {
    if ($Expected.ValueKind -eq [Text.Json.JsonValueKind]::Null) {
        if ($Actual) { throw 'Git journal expected an absent target.' }
        return $null
    }
    $fields = Read-AgentsChatMaintenanceFields $Expected.GetRawText() @(
        'dev', 'ino', 'mode', 'uid', 'gid', 'bytes', 'sha256', 'windowsSecurity')
    $policy = Read-AgentsChatMaintenanceFields $fields.windowsSecurity.GetRawText() @('securityDescriptor', 'attributes')
    if (-not $Actual -or $fields.dev.GetString() -cne $Actual.Dev -or $fields.ino.GetString() -cne $Actual.Ino -or
        $fields.bytes.GetInt64() -ne $Actual.Bytes -or
        $policy.securityDescriptor.GetString() -cne $Actual.SecurityDescriptor -or
        $policy.attributes.GetUInt32() -ne $Actual.Attributes) { throw 'Git journal native file identity or policy changed.' }
    $hash = $fields.sha256.GetString()
    if ($hash -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid Git journal checksum.' }
    return $hash
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported native Git metadata restoration.' }
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
    Check-Roots
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=$identity; controllerIdentity=$ControllerIdentity
        project=$Project; backup=$Backup
        root=@{ securityDescriptor=$root.SecurityDescriptor; attributes=[int](Get-Item -LiteralPath $Project -Force).Attributes }
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
                'admit-saved', 'admit-current', 'seal', 'capture', 'directory', 'guard',
                'create-stage', 'finish-stage', 'write-proof', 'proof', 'publish', 'retire', 'complete', 'check', 'close') -or
            $request.entries.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $request.entries.GetArrayLength() -gt 8 -or
            [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) -cne $ControllerIdentity) {
            throw 'Original Git metadata request differs.'
        }
        $sequence = $id
        $stage = $method
        $entries = @($request.entries.EnumerateArray())
        if ($method -cin @('seal', 'guard', 'retire', 'complete', 'check', 'close')) {
            if ($entries.Count) { throw 'Unexpected Git metadata control payload.' }
            if ($method -cin @('guard', 'retire', 'complete', 'check') -and $phase -cne 'restoring') {
                throw 'Git metadata control is not admitted.'
            }
        } elseif ($method -cnotin @('admit-saved', 'admit-current')) {
            if ($phase -cne 'restoring' -or $entries.Count -ne 1) { throw 'Git metadata operation is not admitted.' }
        }
        if ($method -cne 'close') { Check-Roots }
        $reply = $method
        switch ($method) {
            'admit-saved' {
                if ($phase -cne 'admitting') { throw 'Saved Git admission is closed.' }
                foreach ($item in $entries) {
                    $fields = Read-AgentsChatMaintenanceFields $item.GetRawText() @(
                        'path', 'kind', 'bytes', 'inherit', 'securityDescriptor', 'attributes')
                    $name = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    $inherit = $fields.inherit.GetBoolean()
                    $bytes = $fields.bytes.GetInt64()
                    if (-not $name -or $name.Length -gt 4096 -or $saved.Count -ge 4096 -or
                        $kind -cnotin @('file', 'directory') -or $bytes -lt 0 -or $bytes -gt 16777216 -or
                        ($kind -ceq 'directory' -and $bytes -ne 0) -or
                        ($name -cnotin @('HEAD', 'index', 'refs', 'refs/heads') -and
                            -not $name.StartsWith('refs/heads/', [StringComparison]::Ordinal)) -or
                        ($name -cin @('HEAD', 'index') -and ($inherit -or $kind -cne 'file'))) {
                        throw 'Unsupported saved Git metadata inventory.'
                    }
                    $security = $attributes = $null
                    if ($inherit) {
                        if ($fields.securityDescriptor.ValueKind -ne [Text.Json.JsonValueKind]::Null -or
                            $fields.attributes.ValueKind -ne [Text.Json.JsonValueKind]::Null) { throw 'Absent Git nodes cannot invent saved policy.' }
                    } else {
                        $security = $fields.securityDescriptor.GetString()
                        $attributes = $fields.attributes.GetUInt32()
                        [Deployment.WindowsPrivateFile]::ValidateSourceSecurity($security)
                        if ($attributes -eq 0 -or ($attributes -band (-bnot 8375)) -or
                            (($attributes -band 128) -and $attributes -ne 128) -or
                            [bool]($attributes -band 16) -ne ($kind -ceq 'directory')) { throw 'Unsupported saved Git attributes.' }
                    }
                    $saved.Add($name, @{ Kind=$kind; Bytes=$bytes; Inherit=$inherit; Security=$security; Attributes=$attributes })
                }
            }
            'admit-current' {
                if ($phase -cne 'admitting') { throw 'Current Git admission is closed.' }
                foreach ($item in $entries) {
                    $fields = Read-AgentsChatMaintenanceFields $item.GetRawText() @('path', 'kind')
                    $name = $fields.path.GetString()
                    $kind = $fields.kind.GetString()
                    $expected = if ($saved.ContainsKey($name)) { $saved[$name].Kind }
                        elseif ($name -ceq $guardName) { 'directory' }
                        elseif ($name -cin @('config', 'packed-refs', $proofName)) { 'file' }
                        elseif ($name.EndsWith('.lock', [StringComparison]::Ordinal) -and
                            $saved.ContainsKey($name.Substring(0, $name.Length - 5)) -and
                            $saved[$name.Substring(0, $name.Length - 5)].Kind -ceq 'file') { 'file' }
                        else { throw 'Unexpected current Git metadata inventory.' }
                    if ($kind -cne $expected) { throw 'Current Git metadata kind differs.' }
                    $allowed.Add($name, $kind)
                }
            }
            'seal' {
                if ($phase -cne 'admitting' -or -not $saved.ContainsKey('HEAD') -or -not $saved.ContainsKey('index')) {
                    throw 'Git metadata admission is incomplete.'
                }
                $phase = 'restoring'
            }
            'capture' {
                $fields = Read-Path $entries[0]
                $reply = Capture $fields.path.GetString()
            }
            'directory' {
                $fields = Read-Path $entries[0]
                $name = $fields.path.GetString()
                if (-not $saved.ContainsKey($name) -or $saved[$name].Kind -cne 'directory' -or $directories.ContainsKey($name)) {
                    throw 'Git parent preparation is not admitted.'
                }
                $value = [Deployment.WindowsPrivateFile]::CaptureOptionalSourceSecurity($Project, $name, 'directory')
                if (-not $value) {
                    $lease = [Deployment.WindowsPrivateFile]::CreateSourceDirectory($Project, $name)
                    try { $value = $lease.CaptureIdentity() } finally { $lease.Dispose() }
                    Apply-Policy $name $name $value
                } elseif (-not $saved[$name].Inherit) { Apply-Policy $name $name $value }
                $null = Capture $name
            }
            'guard' {
                if (-not $directories.ContainsKey($guardName)) {
                    $value = [Deployment.WindowsPrivateFile]::CaptureOptionalSourceSecurity($Project, $guardName, 'directory')
                    $lease = if ($value) { [Deployment.WindowsPrivateFile]::OpenDirectory($guardPath) }
                        else { [Deployment.WindowsPrivateFile]::CreateSourceDirectory($Project, $guardName) }
                    $directories.Add($guardName, $lease)
                }
            }
            'create-stage' {
                $fields = Read-Path $entries[0]
                $name = $fields.path.GetString()
                if (-not $saved.ContainsKey($name) -or $saved[$name].Kind -cne 'file' -or $stages.ContainsKey($name)) {
                    throw 'Git private stage is not admitted.'
                }
                $stages.Add($name, [Deployment.WindowsPrivateFile]::CreateSourceFile($Project, $name + '.lock'))
            }
            'finish-stage' {
                $fields = Read-Path $entries[0]
                $name = $fields.path.GetString()
                if (-not $stages.ContainsKey($name)) { throw 'Git private stage is absent.' }
                $value = $stages[$name].Finish($saved[$name].Bytes)
                $stages[$name].Dispose()
                [void]$stages.Remove($name)
                Apply-Policy $name ($name + '.lock') $value
            }
            'write-proof' {
                if ($proof -or -not $directories.ContainsKey($guardName) -or $stages.Count) {
                    throw 'Git intent publication is not admitted.'
                }
                $fields = Read-AgentsChatMaintenanceFields $entries[0].GetRawText() @('text')
                $text = $fields.text.GetString()
                if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw 'Git intent exceeds its private evidence budget.' }
                $proof = [Deployment.WindowsPrivateFile]::Publish($proofPath, $text)
            }
            'proof' {
                $fields = Read-AgentsChatMaintenanceFields $entries[0].GetRawText() @('sha256', 'dev', 'ino', 'bytes')
                if (-not $directories.ContainsKey($guardName)) { throw 'Git intent retention is not admitted.' }
                $proofHash = $fields.sha256.GetString()
                if (-not $proof) { $proof = [Deployment.WindowsPrivateFile]::Open($proofPath, $proofHash) }
                elseif ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                    [Text.Encoding]::UTF8.GetBytes($proof.ReadText()))).ToLowerInvariant() -cne $proofHash) {
                    throw 'Git private intent checksum differs.'
                }
                $value = $proof.CaptureIdentity()
                if ($value.Dev -cne $fields.dev.GetString() -or $value.Ino -cne $fields.ino.GetString() -or
                    $proof.ByteLength -ne $fields.bytes.GetInt32()) { throw 'Git private intent identity differs.' }
            }
            'publish' {
                if (-not $proof) { throw 'Git publication requires retained private intent.' }
                $fields = Read-Path $entries[0] @('path', 'before', 'staged')
                $name = $fields.path.GetString()
                if (-not $saved.ContainsKey($name) -or $saved[$name].Kind -cne 'file') { throw 'Git publication path differs.' }
                $before = [Deployment.WindowsPrivateFile]::CaptureOptionalSourceSecurity($Project, $name, 'file')
                $staged = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $name + '.lock', 'file')
                $beforeHash = Match-File $fields.before $before
                $stagedHash = Match-File $fields.staged $staged
                [Deployment.WindowsPrivateFile]::PublishSourceFile($Project, $name, $staged, $before, $stagedHash, $beforeHash)
            }
            'complete' {
                if (-not $proof -or $stages.Count) { throw 'Git journal is incomplete.' }
                foreach ($name in $saved.Keys) {
                    $value = [Deployment.WindowsPrivateFile]::CaptureSourceSecurity($Project, $name, $saved[$name].Kind)
                    if ($saved[$name].Inherit -and $saved[$name].Kind -ceq 'file') {
                        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($value.SecurityDescriptor)
                        foreach ($ace in $descriptor.DiscretionaryAcl) {
                            if (-not ($ace.AceFlags -band [Security.AccessControl.AceFlags]::Inherited)) {
                                throw 'Materialized Git metadata did not inherit its parent policy.'
                            }
                        }
                    }
                }
            }
            'retire' {
                if (-not $proof -or -not $directories.ContainsKey($guardName)) { throw 'Git private journal retirement is not admitted.' }
                $retiredIdentity = $proof.CaptureIdentity()
                $length = $proof.ByteLength
                $proof.Dispose()
                $proof = $null
                $retirement = [Deployment.WindowsPrivateFile]::RetainForRetirement(
                    $proofPath, $proofHash, $retiredIdentity.Dev, $retiredIdentity.Ino, $length)
                try { $retirement.Delete() } finally { $retirement.Dispose() }
                $retiredIdentity = $directories[$guardName].CaptureIdentity()
                $directories[$guardName].Dispose()
                [void]$directories.Remove($guardName)
                [Deployment.WindowsPrivateFile]::RemoveSourceEntry(
                    $Project, $guardName, 'directory', $retiredIdentity.Dev, $retiredIdentity.Ino)
            }
            'check' { }
            'close' { }
        }
        if ($method -cne 'close') { Check-Roots }
        [Console]::Out.WriteLine((@{ id=$id; type='reply'; processIdentity=$identity; value=$reply } | ConvertTo-Json -Depth 12 -Compress))
        [Console]::Out.Flush()
        if ($method -ceq 'close') { break }
    }
} catch {
    $failure = $_
} finally {
    $cleanup = [Collections.Generic.List[object]]::new()
    foreach ($value in @($stages.Values) + @($directories.Values) + @($proof, $root, $backupLease, $watch)) {
        if ($null -ne $value) { try { $value.Dispose() } catch { $cleanup.Add($_) } }
    }
    if ($failure) { [Console]::Error.WriteLine("Git metadata security failed at $stage`: $($failure.Exception)") }
    foreach ($errorRecord in $cleanup) { [Console]::Error.WriteLine("Git metadata cleanup failed: $($errorRecord.Exception)") }
    if ($failure -or $cleanup.Count) { exit 1 }
}
