param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$state = Join-Path $Control 'state.json'
$acl = Get-Acl -LiteralPath $state
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
Set-Acl -LiteralPath $state -AclObject $acl
