$ErrorActionPreference = 'Stop'
$target = $env:VOICE_PRIVATE_DIRECTORY
if (-not $target -or $target -notmatch '^[A-Za-z]:[\\/]') {
    throw 'Private configuration requires an absolute local drive path.'
}
$target = [System.IO.Path]::GetFullPath($target)
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($target))
if ($drive.DriveFormat -ne 'NTFS') { throw 'Private configuration requires NTFS.' }
if (Test-Path -LiteralPath $target) { throw 'Private configuration directory already exists.' }
$parent = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetDirectoryName($target))
if (-not $parent.Exists) { throw 'Configuration parent directory is missing.' }
while ($null -ne $parent) {
    if (($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Private configuration directory must not traverse a reparse point.'
    }
    $parent = $parent.Parent
}
$security = New-Object System.Security.AccessControl.DirectorySecurity
$security.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
}
[System.IO.Directory]::CreateDirectory($target, $security) | Out-Null
