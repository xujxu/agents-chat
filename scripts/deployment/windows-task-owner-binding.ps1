function Get-AgentsChatTaskOwnerBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][int]$OwnerPid,
        [Parameter(Mandatory)][string]$OwnerIdentity,
        [Parameter(Mandatory)][string]$Definition,
        [Parameter(Mandatory)][string]$SecurityDescriptor
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $state = @{ Stage = 'input' }
    $owner = $null
    try {
        if ($TaskName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$' -or $OwnerPid -lt 1 -or
            $OwnerIdentity -cnotmatch '^[1-9][0-9]*:[1-9][0-9]*$' -or $OwnerIdentity.Length -gt 64 -or
            $Definition.Length -gt 262144 -or $Definition.Contains([char]0) -or
            $SecurityDescriptor.Length -gt 65536 -or $SecurityDescriptor -match '[\x00\r\n]') {
            throw 'Unsupported task owner input.'
        }
        $state.Stage = 'observer-privilege'
        $observer = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($observer)
            if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                throw 'Task owner observation requires elevation.'
            }
        } finally { $observer.Dispose() }
        $state.Stage = 'process'
        $owner = [Diagnostics.Process]::GetProcessById($OwnerPid)
        $null = $owner.Handle
        if ($owner.HasExited -or "$OwnerPid`:$($owner.StartTime.ToUniversalTime().Ticks)" -cne $OwnerIdentity) {
            throw 'Original task owner identity differs.'
        }
        $scheduler = New-Object -ComObject 'Schedule.Service'
        $scheduler.Connect()
        $folder = $scheduler.GetFolder('\')

        function Read-TaskOwnerBinding {
            $state.Stage = 'definition'
            $task = $folder.GetTask($TaskName)
            if ($task.Path -cne "\$TaskName" -or [string]$task.Xml -cne $Definition -or
                [string]$task.GetSecurityDescriptor(7) -cne $SecurityDescriptor -or
                $task.Definition.Actions.Count -ne 1) { throw 'Retained task definition differs.' }
            $action = $task.Definition.Actions.Item(1)
            if ([int]$action.Type -ne 0 -or -not [IO.Path]::IsPathRooted([string]$action.Path)) {
                throw 'Task does not use one literal executable action.'
            }
            $state.Stage = 'instance'
            $instances = $task.GetInstances(0)
            if ($instances.Count -ne 1 -or [int]$task.State -ne 4) { throw 'Task instance is ambiguous or not running.' }
            $instance = $instances.Item(1)
            $instance.Refresh()
            $instanceGuid = [guid]$instance.InstanceGuid
            if ($instance.Name -cne $TaskName -or $instance.Path -cne "\$TaskName" -or
                [int]$instance.EnginePID -ne $OwnerPid -or [int]$instance.State -ne 4 -or
                $instanceGuid -eq [guid]::Empty) { throw 'Native instance does not identify the original task owner.' }
            $state.Stage = 'process'
            if ($owner.HasExited -or "$OwnerPid`:$($owner.StartTime.ToUniversalTime().Ticks)" -cne $OwnerIdentity) {
                throw 'Original task owner changed.'
            }
            $executable = $owner.MainModule.FileName
            if (-not [string]::Equals($executable, [string]$action.Path, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Original task owner image differs from the declared action.'
            }
            $process = @(Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid" -OperationTimeoutSec 10)
            if ($process.Count -ne 1 -or [int]$process[0].ProcessId -ne $OwnerPid -or
                [int]$process[0].SessionId -ne $owner.SessionId) { throw 'Original task owner process is unavailable.' }
            $state.Stage = 'principal'
            $declared = $task.Definition.Principal
            if ([int]$declared.LogonType -notin @(2, 3) -or [string]::IsNullOrWhiteSpace($declared.UserId)) {
                throw 'Unsupported task principal.'
            }
            $sid = if ($declared.UserId -match '^S-1-') {
                [Security.Principal.SecurityIdentifier]::new($declared.UserId)
            } else {
                ([Security.Principal.NTAccount]::new($declared.UserId)).Translate([Security.Principal.SecurityIdentifier])
            }
            $actual = Invoke-CimMethod -InputObject $process[0] -MethodName GetOwnerSid -OperationTimeoutSec 10
            if ($actual.ReturnValue -ne 0 -or $actual.Sid -cne $sid.Value -or $owner.HasExited) {
                throw 'Original task owner account differs.'
            }
            [pscustomobject][ordered]@{
                status = 'task-owner-bound'
                runtimeAuthority = $false
                taskName = $TaskName
                taskPath = "\$TaskName"
                instanceGuid = $instanceGuid.ToString('D')
                ownerPid = $OwnerPid
                ownerIdentity = $OwnerIdentity
                principalSid = $sid.Value
                sessionId = $owner.SessionId
                executable = $executable
                enabled = [bool]$task.Enabled
            }
        }

        $first = Read-TaskOwnerBinding
        $second = Read-TaskOwnerBinding
        $state.Stage = 'stable-observation'
        if (($first | ConvertTo-Json -Depth 4 -Compress) -cne ($second | ConvertTo-Json -Depth 4 -Compress) -or
            $owner.HasExited) { throw 'Task owner observation changed.' }
        $finalTask = $folder.GetTask($TaskName)
        if ([string]$finalTask.Xml -cne $Definition -or
            [string]$finalTask.GetSecurityDescriptor(7) -cne $SecurityDescriptor) {
            throw 'Task policy changed during process inspection.'
        }
        $finalInstances = $finalTask.GetInstances(0)
        if ($finalInstances.Count -ne 1) { throw 'Task instances changed during process inspection.' }
        $finalInstance = $finalInstances.Item(1)
        $finalInstance.Refresh()
        if (([guid]$finalInstance.InstanceGuid).ToString('D') -cne $first.instanceGuid -or
            [int]$finalInstance.EnginePID -ne $OwnerPid -or [int]$finalInstance.State -ne 4 -or $owner.HasExited) {
            throw 'Original task instance changed during process inspection.'
        }
        return $first
    } catch {
        throw "Task owner binding refused: $($state.Stage)."
    } finally {
        if ($owner) { $owner.Dispose() }
    }
}
