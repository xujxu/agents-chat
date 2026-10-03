param(
    [Parameter(Mandatory)][string]$File,
    [ValidateSet('inspect', 'broaden')][string]$Action = 'inspect'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$acl = Get-Acl -LiteralPath $File
if ($Action -ceq 'broaden') {
    if ([IO.Path]::GetFileName($File) -cne '.env.local') { throw 'Unsupported fixture mutation.' }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Read,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $File -AclObject $acl
    $acl = Get-Acl -LiteralPath $File
}
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Group -bor
    [Security.AccessControl.AccessControlSections]::Access
[pscustomobject]@{
    securityDescriptor = $acl.GetSecurityDescriptorSddlForm($sections)
    attributes = [int](Get-Item -LiteralPath $File -Force).Attributes
} | ConvertTo-Json -Compress
