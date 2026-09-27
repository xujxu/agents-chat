function Get-TaskNoTunnelMode {
    param($Task, [bool]$Explicit, [bool]$Requested)
    if ($Explicit) { return $Requested }
    if (-not $Task) { return $false }
    foreach ($action in $Task.Actions) {
        $tokens = [regex]::Matches([string]$action.Arguments, '"[^"]*"|\S+')
        foreach ($token in $tokens) {
            if ($token.Value -ieq '-NoTunnel') { return $true }
        }
    }
    return $false
}
