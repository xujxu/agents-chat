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
    $user = [string]$Definition.Principal.UserId
    $taskSid = if ($user -match '^S-\d-') {
        [Security.Principal.SecurityIdentifier]::new($user)
    } else {
        ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier])
    }
    $profile = [ordered]@{
        account=($taskSid.Value -ceq $sid)
        logon=([int]$Definition.Principal.LogonType -in @(2, 3))
        runLevel=([int]$Definition.Principal.RunLevel -eq 1)
        disabled=(-not $Definition.Settings.Enabled)
        triggers=($Definition.Triggers.Count -eq 0)
        restart=($Definition.Settings.RestartCount -eq 0)
        demandStart=([bool]$Definition.Settings.AllowDemandStart)
        instances=([int]$Definition.Settings.MultipleInstances -eq 2)
        action=($Definition.Actions.Count -eq 1 -and [int]$Definition.Actions.Item(1).Type -eq 0)
        size=($Definition.XmlText.Length -le 65536)
    }
    $invalid = @($profile.Keys | Where-Object { -not $profile[$_] })
    if ($invalid.Count) {
        throw "First-task registration requires the inhibited current-account execution profile: $($invalid -join ',')."
    }
    # TASK_CREATE is atomic: even a case-only competing registration must not be replaced.
    return $Folder.RegisterTask($TaskName, $Definition.XmlText, (2 -bor 16 -bor 32),
        $sid, $null, [int]$Definition.Principal.LogonType, $null)
}
