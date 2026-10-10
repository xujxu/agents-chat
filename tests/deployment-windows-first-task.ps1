$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helper = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment/windows-first-task.ps1'))
if (-not (Test-Path -LiteralPath $helper)) { throw 'Missing native create-only first-task registration.' }
. $helper
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
foreach ($logon in @(2, 3)) {
    $name = "Agents-First-Atomic-Test-$([guid]::NewGuid())"
    $registered = $false
    try {
        $definition = $scheduler.NewTask(0)
        $definition.RegistrationInfo.Description = 'Inert first-task atomic registration fixture.'
        $definition.Principal.UserId = $sid
        $definition.Principal.LogonType = $logon
        $definition.Principal.RunLevel = 1
        $definition.Settings.Enabled = $false
        $definition.Settings.MultipleInstances = 2
        $definition.Settings.AllowDemandStart = $true
        $definition.Settings.ExecutionTimeLimit = 'PT0S'
        $action = $definition.Actions.Create(0)
        $action.Path = $pwsh
        $action.Arguments = '-NoProfile -NonInteractive -Command "exit 0"'
        $action.WorkingDirectory = $PSScriptRoot
        foreach ($policy in @('enabled', 'trigger', 'restart', 'run-level', 'multiple-instances', 'demand-start', 'extra-action')) {
            $invalid = $scheduler.NewTask(0)
            $invalid.XmlText = $definition.XmlText
            switch ($policy) {
                'enabled' { $invalid.Settings.Enabled = $true }
                'trigger' { $null = $invalid.Triggers.Create(9) }
                'restart' { $invalid.Settings.RestartInterval = 'PT1M'; $invalid.Settings.RestartCount = 1 }
                'run-level' { $invalid.Principal.RunLevel = 0 }
                'multiple-instances' { $invalid.Settings.MultipleInstances = 1 }
                'demand-start' { $invalid.Settings.AllowDemandStart = $false }
                'extra-action' { $extra = $invalid.Actions.Create(0); $extra.Path = $pwsh }
            }
            $refused = $false
            try {
                $null = Register-AgentsChatFirstTask -Folder $folder -TaskName $name -Definition $invalid
                $registered = $true
            } catch { $refused = $true }
            Assert $refused "First-task creation must refuse unsupported policy before registration: $policy"
            $absent = $false
            try { $null = $folder.GetTask($name) }
            catch {
                if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw }
                $absent = $true
            }
            Assert $absent "Rejected first-task definition was registered: $policy"
        }
        $created = Register-AgentsChatFirstTask -Folder $folder -TaskName $name -Definition $definition
        $registered = $true
        Assert (-not $created.Enabled -and $created.GetInstances(0).Count -eq 0) 'First task was not created inhibited.'
        $before = [string]$created.Xml
        $security = [string]$created.GetSecurityDescriptor(7)
        $definition.RegistrationInfo.Description = 'Must not replace the registered first task.'
        $refused = $false
        try {
            $null = Register-AgentsChatFirstTask -Folder $folder -TaskName $name.ToUpperInvariant() -Definition $definition
        } catch {
            if ($_.Exception.GetBaseException().HResult -ne -2147024713) { throw }
            $refused = $true
        }
        Assert $refused 'Native create-only registration replaced an existing task.'
        $current = $folder.GetTask($name)
        Assert ([string]$current.Xml -ceq $before -and [string]$current.GetSecurityDescriptor(7) -ceq $security -and
            -not $current.Enabled -and $current.GetInstances(0).Count -eq 0) 'Competing registration altered the original task.'
        Write-Output "PASS: native first-task create-only registration preserves existing definition and security; logon=$logon"
    } finally {
        if ($registered) { $folder.DeleteTask($name, 0) }
    }
}
