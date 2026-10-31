function Resolve-AgentsChatTaskOptions {
    param($Task, [string]$ProjectDir, [string]$WatchdogScript, [Collections.IDictionary]$Explicit)

    $options = @{
        UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        TaskLogonType = 'Interactive'
        TaskTriggerType = 'AtLogOn'
        NoTunnel = $false
    }
    if ($Task) {
        $actions = @($Task.Actions)
        $triggers = @($Task.Triggers)
        $expectedArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$WatchdogScript`""
        if ($actions.Count -ne 1 -or
            $actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
            $actions[0].WorkingDirectory -ine $ProjectDir -or
            ($actions[0].Arguments -ine $expectedArguments -and $actions[0].Arguments -ine "$expectedArguments -NoTunnel")) {
            throw 'Existing task action is not the supported literal watchdog command; no task was changed.'
        }
        $logon = $Task.Principal.LogonType.ToString()
        if ($logon -notin @('Interactive', 'S4U') -or [string]::IsNullOrWhiteSpace($Task.Principal.UserId)) {
            throw 'Existing task principal requires unsupported credentials or identity; no task was changed.'
        }
        if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -notin @('MSFT_TaskBootTrigger', 'MSFT_TaskLogonTrigger')) {
            throw 'Existing task trigger is unsupported or ambiguous; no task was changed.'
        }
        $options.UserId = $Task.Principal.UserId
        $options.TaskLogonType = $logon
        $options.TaskTriggerType = if ($triggers[0].CimClass.CimClassName -eq 'MSFT_TaskBootTrigger') { 'AtStartup' } else { 'AtLogOn' }
        $options.NoTunnel = $actions[0].Arguments -ieq "$expectedArguments -NoTunnel"
    }
    foreach ($name in @('UserId', 'TaskLogonType', 'TaskTriggerType', 'NoTunnel')) {
        if ($name -in $Explicit.Keys) { $options[$name] = $Explicit[$name] }
    }
    return $options
}
