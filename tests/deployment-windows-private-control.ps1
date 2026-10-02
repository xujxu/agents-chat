param([Parameter(Mandatory)][string]$Control, [switch]$ExposeState)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($entry in @((Get-Item -LiteralPath $Control)) + @(Get-ChildItem -LiteralPath $Control -Recurse)) {
    $acl = Get-Acl -LiteralPath $entry.FullName
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = if ($entry.PSIsContainer) {
            [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl',
                'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else {
            [Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow')
        }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $entry.FullName -AclObject $acl
}
if ($ExposeState) {
    $state = Join-Path $Control 'state.json'
    $acl = Get-Acl -LiteralPath $state
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $state -AclObject $acl
}
