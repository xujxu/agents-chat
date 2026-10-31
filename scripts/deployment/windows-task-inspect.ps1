[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$ProjectDir,
    [Parameter(Mandatory)][string]$WatchdogScript
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$stage = 'input'

try {
    if ($TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or
        -not [IO.Path]::IsPathRooted($ProjectDir) -or -not [IO.Path]::IsPathRooted($WatchdogScript)) {
        throw 'Invalid task definition input.'
    }
    $stage = 'observer-privilege'
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Task instance observation requires an elevated administrator.'
    }
    . (Join-Path $PSScriptRoot 'windows-task-policy.ps1')
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')

    function Read-TaskDefinition {
        $registered = $folder.GetTask($TaskName)
        $task = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
        if ($registered.Path -cne "\$TaskName" -or $task.TaskPath -cne '\' -or $task.TaskName -cne $TaskName) {
            throw 'Task definition name or folder changed.'
        }
        $options = Resolve-AgentsChatTaskOptions -Task $task -ProjectDir $ProjectDir -WatchdogScript $WatchdogScript -Explicit @{}
        $sid = if ($options.UserId -match '^S-1-') {
            [Security.Principal.SecurityIdentifier]::new($options.UserId)
        } else {
            ([Security.Principal.NTAccount]::new($options.UserId)).Translate([Security.Principal.SecurityIdentifier])
        }
        $running = $registered.GetInstances(0)
        if ($running.Count -gt 128) { throw 'Task instance budget exceeded.' }
        $instances = @(
            for ($index = 1; $index -le $running.Count; $index++) {
                $instance = $running.Item($index)
                $instance.Refresh()
                if ($instance.Name -cne $TaskName -or $instance.Path -cne "\$TaskName") {
                    throw 'Task instance belongs to another definition.'
                }
                [ordered]@{
                    instanceGuid = ([Guid]$instance.InstanceGuid).ToString('D')
                    enginePid = [int]$instance.EnginePID
                    state = [int]$instance.State
                    currentAction = [string]$instance.CurrentAction
                }
            }
        )
        [ordered]@{
            version = 1
            taskName = $TaskName
            taskPath = '\'
            project = $ProjectDir
            watchdog = $WatchdogScript
            principalSid = $sid.Value
            options = $options
            definition = [string]$registered.Xml
            securityDescriptor = [string]$registered.GetSecurityDescriptor(7)
            enabled = [bool]$registered.Enabled
            state = $task.State.ToString()
            lastRunTicks = $registered.LastRunTime.ToUniversalTime().Ticks.ToString()
            lastResult = [long]$registered.LastTaskResult
            instances = @($instances | Sort-Object { $_.instanceGuid })
        }
    }

    $stage = 'definition'
    $first = Read-TaskDefinition | ConvertTo-Json -Depth 8 -Compress
    $stage = 'stable-definition'
    $second = Read-TaskDefinition | ConvertTo-Json -Depth 8 -Compress
    if ($first -cne $second) { throw 'Task definition or instances changed during observation.' }
    [Console]::Out.WriteLine($first)
} catch {
    [Console]::Error.WriteLine("Task definition inspection refused: $stage.")
    exit 1
}
