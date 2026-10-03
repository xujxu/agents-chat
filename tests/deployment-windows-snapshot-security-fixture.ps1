param(
    [Parameter(Mandatory)][string]$File,
    [ValidateSet('inspect', 'broaden', 'broaden-inheritable', 'broaden-git-index',
        'broaden-git-index-users', 'unbroaden-git-index-users')][string]$Action = 'inspect'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$acl = Get-Acl -LiteralPath $File
if ($Action -cne 'inspect') {
    if ($Action -cin @('broaden-git-index', 'broaden-git-index-users', 'unbroaden-git-index-users')) {
        if ([IO.Path]::GetFileName($File) -cne 'index' -or
            [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($File)) -cne '.git') {
            throw 'Unsupported Git index fixture mutation.'
        }
    } elseif ([IO.Path]::GetFileName($File) -cnotin @('.env.local', 'backup-parent', 'app')) {
        throw 'Unsupported fixture mutation.'
    }
    $sidValue = if ($Action.EndsWith('-users', [StringComparison]::Ordinal)) { 'S-1-5-32-545' } else { 'S-1-1-0' }
    $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
    $rule = if ($Action -ceq 'broaden-inheritable') {
        if ([IO.Path]::GetFileName($File) -cne 'app') { throw 'Unsupported inheritable fixture mutation.' }
        [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    } else {
        [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read,
            [Security.AccessControl.AccessControlType]::Allow)
    }
    if ($Action -ceq 'unbroaden-git-index-users') { $acl.RemoveAccessRuleSpecific($rule) }
    else { $acl.AddAccessRule($rule) }
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
