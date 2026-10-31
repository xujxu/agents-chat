$ErrorActionPreference = 'Stop'
$Repository = Split-Path -Parent $PSScriptRoot
$Root = Join-Path $env:TEMP ("agents-task-options-" + [Guid]::NewGuid().ToString('N'))
$Scripts = Join-Path $Root 'project with spaces\scripts'
$Project = Split-Path -Parent $Scripts
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskNames = [Collections.Generic.List[string]]::new()
$Failures = [Collections.Generic.List[string]]::new()

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) {
        if ($Label -match 'arguments|script path') {
            Write-Host (@{ label = $Label; actual = $Actual; expected = $Expected } | ConvertTo-Json -Compress)
        }
        throw "Assertion failed: $Label"
    }
}

function Invoke-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        Write-Host "PASS: $Name"
    } catch {
        $Failures.Add($Name)
        Write-Host "FAIL: $Name - $($_.Exception.Message)"
    }
}

function Read-ScriptAst([string]$Path) {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "PowerShell 5.1 parse errors in $Path" }
    return $ast
}

function Get-FunctionText($Ast, [string]$Name) {
    $found = @($Ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }.GetNewClosure(), $true))
    if ($found.Count -ne 1) { throw "Expected one function named $Name" }
    return $found[0].Extent.Text
}

try {
    New-Item -ItemType Directory -Path $Scripts -Force | Out-Null
    $canonicalScripts = & node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $Scripts
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($canonicalScripts)) {
        throw 'Could not canonicalize the generated Windows fixture path'
    }
    $Scripts = $canonicalScripts
    $Project = Split-Path -Parent $Scripts
    $Root = Split-Path -Parent $Project
    Copy-Item -LiteralPath (Join-Path $Repository 'scripts\install-scheduled-task.ps1') -Destination $Scripts
    Set-Content -LiteralPath (Join-Path $Scripts 'service-watchdog.ps1') -Value 'param([switch]$NoTunnel)' -Encoding UTF8
    $Installer = Join-Path $Scripts 'install-scheduled-task.ps1'
    $Current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $WatchdogAst = Read-ScriptAst (Join-Path $Repository 'scripts\service-watchdog.ps1')
    $DeployAst = Read-ScriptAst (Join-Path $Repository 'scripts\deploy.ps1')
    $PolicyFile = Join-Path $Repository 'scripts\deployment\windows-task-policy.ps1'
    $null = Read-ScriptAst $PolicyFile
    $null = Read-ScriptAst $Installer

    Invoke-Case 'default task principal is the current Windows account' {
        $name = 'Agents-Chat-Test-' + [Guid]::NewGuid().ToString('N')
        $TaskNames.Add($name)
        $null = & $Installer -TaskName $name -ProjectDir $Project
        $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        $sid = ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier])
        Assert-Equal $sid.Value $Current.User.Value 'default principal SID'
        Assert-Equal $task.Principal.LogonType.ToString() 'Interactive' 'default logon type'
        Assert-Equal $task.State.ToString() 'Ready' 'registration must not start the application'
        Assert-Equal $task.Actions[0].Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Scripts 'service-watchdog.ps1')`"" 'default tunnel arguments'
    }

    foreach ($mode in @(@{ Logon = 'Interactive'; Trigger = 'AtLogOn' }, @{ Logon = 'S4U'; Trigger = 'AtStartup' })) {
        Invoke-Case "explicit principal and NoTunnel survive $($mode.Logon)/$($mode.Trigger) registration" {
            $name = 'Agents-Chat-Test-' + [Guid]::NewGuid().ToString('N')
            $TaskNames.Add($name)
            $null = & $Installer -TaskName $name -ProjectDir $Project -UserId $Current.Name `
                -LogonType $mode.Logon -TriggerType $mode.Trigger -NoTunnel
            $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
            Assert-Equal $task.Principal.LogonType.ToString() $mode.Logon 'explicit logon'
            Assert-Equal $task.Actions.Count 1 'single action'
            Assert-Equal $task.Actions[0].Execute $PowerShell 'PowerShell executable'
            Assert-Equal $task.Actions[0].WorkingDirectory $Project 'working directory'
            Assert-Equal $task.Actions[0].Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Scripts 'service-watchdog.ps1')`" -NoTunnel" 'NoTunnel task arguments'
            $expectedTrigger = if ($mode.Trigger -eq 'AtStartup') { 'MSFT_TaskBootTrigger' } else { 'MSFT_TaskLogonTrigger' }
            Assert-Equal $task.Triggers[0].CimClass.CimClassName $expectedTrigger 'trigger class'
            Assert-Equal $task.State.ToString() 'Ready' 'application remains unstarted'
        }
    }

    Invoke-Case 'omitted deploy options preserve the actual registered task modes and account' {
        . $PolicyFile
        $name = 'Agents-Chat-Test-' + [Guid]::NewGuid().ToString('N')
        $TaskNames.Add($name)
        $null = & $Installer -TaskName $name -ProjectDir $Project -UserId $Current.Name `
            -LogonType S4U -TriggerType AtStartup -NoTunnel
        $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        $watchdog = Join-Path $Scripts 'service-watchdog.ps1'
        $before = Export-ScheduledTask -TaskName $name
        $options = Resolve-AgentsChatTaskOptions -Task $task -ProjectDir $Project -WatchdogScript $watchdog -Explicit @{}
        Assert-Equal $options.UserId $task.Principal.UserId 'retained account'
        Assert-Equal $options.TaskLogonType 'S4U' 'retained S4U'
        Assert-Equal $options.TaskTriggerType 'AtStartup' 'retained startup trigger'
        Assert-Equal $options.NoTunnel $true 'retained NoTunnel'
        $changed = Resolve-AgentsChatTaskOptions -Task $task -ProjectDir $Project -WatchdogScript $watchdog `
            -Explicit @{ NoTunnel = $false; TaskLogonType = 'Interactive'; TaskTriggerType = 'AtLogOn'; UserId = $Current.Name }
        Assert-Equal $changed.NoTunnel $false 'explicit tunnel reenablement'
        Assert-Equal $changed.TaskLogonType 'Interactive' 'explicit logon'
        Assert-Equal $changed.TaskTriggerType 'AtLogOn' 'explicit trigger'
        Assert-Equal $changed.UserId $Current.Name 'explicit account'
        Assert-Equal (Export-ScheduledTask -TaskName $name) $before 'resolution is read-only'
        $foreign = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -Command `"exit 0`"" -WorkingDirectory $Project
        $null = Set-ScheduledTask -TaskName $name -Action $foreign
        $foreignTask = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        $rejected = $false
        try {
            $null = Resolve-AgentsChatTaskOptions -Task $foreignTask -ProjectDir $Project -WatchdogScript $watchdog -Explicit @{}
        } catch {
            if ($_.Exception.Message -notmatch 'action') { throw }
            $rejected = $true
        }
        Assert-Equal $rejected $true 'foreign action refused rather than adopted'
    }

    Invoke-Case 'staged public deploy refuses task reconfiguration without registration' {
        foreach ($name in @('UserId', 'NoTunnel')) {
            if ($DeployAst.ParamBlock.Parameters.Name.VariablePath.UserPath -notcontains $name) {
                throw "deploy.ps1 does not declare $name"
            }
        }
        $TaskName = 'Agents-Chat-Test-' + [Guid]::NewGuid().ToString('N')
        $text = & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File (Join-Path $Repository 'scripts/deploy.ps1') -TaskName $TaskName `
            -ProjectDir $Project -UserId $Current.Name -TaskLogonType S4U -TaskTriggerType AtStartup -NoTunnel -Json
        Assert-Equal $LASTEXITCODE 1 'unsupported task changes fail'
        $result = ($text -join "`n") | ConvertFrom-Json
        Assert-Equal $result.code 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' 'task changes are explicitly unsupported'
        Assert-Equal ([bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) $false 'no task registered'
    }

    Invoke-Case 'watchdog child command preserves spaced paths and both tunnel modes' {
        if ($WatchdogAst.ParamBlock.Parameters.Name.VariablePath.UserPath -notcontains 'NoTunnel') {
            throw 'Watchdog does not declare NoTunnel'
        }
        . ([scriptblock]::Create((Get-FunctionText $WatchdogAst 'Get-StartScriptArguments')))
        $start = Join-Path $Scripts 'start.ps1'
        $output = Join-Path $Project 'child-mode.json'
        Set-Content -LiteralPath $start -Encoding UTF8 -Value @'
param([switch]$NoTunnel)
@{ noTunnel = [bool]$NoTunnel; script = $PSCommandPath } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'child-mode.json')
'@
        foreach ($disabled in @($false, $true)) {
            $arguments = Get-StartScriptArguments -StartScript $start -NoTunnel:$disabled
            $child = Start-Process -FilePath $PowerShell -ArgumentList $arguments -PassThru -WindowStyle Hidden
            try {
                if (-not $child.WaitForExit(30000)) { throw 'Inert child startup timed out' }
                Assert-Equal $child.ExitCode 0 'child exit'
                $result = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
                Assert-Equal $result.noTunnel $disabled 'child tunnel choice'
                Assert-Equal $result.script $start 'literal spaced script path'
            } finally {
                if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
                $child.Dispose()
            }
        }
    }
} finally {
    foreach ($name in $TaskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop }
    }
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
if ($Failures.Count) { throw "$($Failures.Count) Windows task option cases failed: $($Failures -join ', ')" }
exit 0
