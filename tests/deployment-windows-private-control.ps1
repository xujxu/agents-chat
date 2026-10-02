param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][ValidateSet('expose', 'restore')][string]$Action,
    [string]$OriginalSecurity
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$state = Join-Path $Control 'state.json'
if ($Action -eq 'expose') {
    $acl = Get-Acl -LiteralPath $state
    $original = $acl.Sddl
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $state -AclObject $acl
    Write-Output $original
} else {
    if ([string]::IsNullOrWhiteSpace($OriginalSecurity)) { throw 'Original state security is required' }
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetSecurityDescriptorSddlForm($OriginalSecurity)
    Set-Acl -LiteralPath $state -AclObject $acl
    if ((Get-Acl -LiteralPath $state).Sddl -cne $OriginalSecurity) { throw 'Original state security was not restored exactly' }
}
