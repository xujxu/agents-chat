param(
    [Parameter(Mandatory)][string]$File,
    [Parameter(Mandatory)][ValidateSet('broaden', 'restore')][string]$Action,
    [string]$SecurityDescriptor
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([IO.Path]::GetFileName($File) -cne '.env.local') { throw 'Expected the fixture dotenv file.' }
$acl = Get-Acl -LiteralPath $File
if ($Action -ceq 'broaden') {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
} else {
    if (-not $SecurityDescriptor) { throw 'Original fixture security descriptor is required.' }
    $acl.SetSecurityDescriptorSddlForm($SecurityDescriptor)
}
Set-Acl -LiteralPath $File -AclObject $acl
