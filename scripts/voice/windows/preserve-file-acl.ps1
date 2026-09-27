$ErrorActionPreference = 'Stop'
$security = [System.IO.File]::GetAccessControl($env:VOICE_ACL_SOURCE)
$security.SetAccessRuleProtection($true, $true)
[System.IO.File]::SetAccessControl($env:VOICE_ACL_TARGET, $security)
