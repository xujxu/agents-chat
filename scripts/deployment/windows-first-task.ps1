function Register-AgentsChatFirstTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Folder,
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][object]$Definition
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $sid = $identity.User.Value
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        $administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally { $identity.Dispose() }
    if (-not $administrator -or -not [Runtime.InteropServices.Marshal]::IsComObject($Folder) -or
        -not [Runtime.InteropServices.Marshal]::IsComObject($Definition) -or $Folder.Path -cne '\' -or
        $TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$') {
        throw 'First-task registration requires an elevated native root-folder context.'
    }
    if ($Definition.Principal.UserId -cne $sid -or [int]$Definition.Principal.LogonType -notin @(2, 3) -or
        [int]$Definition.Principal.RunLevel -ne 1 -or $Definition.Settings.Enabled -or
        $Definition.Triggers.Count -ne 0 -or $Definition.Settings.RestartCount -ne 0 -or
        -not $Definition.Settings.AllowDemandStart -or [int]$Definition.Settings.MultipleInstances -ne 2 -or
        $Definition.Actions.Count -ne 1 -or [int]$Definition.Actions.Item(1).Type -ne 0 -or
        $Definition.XmlText.Length -gt 65536) {
        throw 'First-task registration requires the inhibited current-account execution profile.'
    }
    # TASK_CREATE is atomic: even a case-only competing registration must not be replaced.
    return $Folder.RegisterTask($TaskName, $Definition.XmlText, (2 -bor 16 -bor 32),
        $sid, $null, [int]$Definition.Principal.LogonType, $null)
}
