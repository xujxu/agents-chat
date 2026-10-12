param(
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$TaskName,
    [switch]$CompletionRecovery
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$owner = $null
try {
    if ($CompletionRecovery) {
        $output = & (Join-Path $PSScriptRoot 'deployment-windows-cold-completion-recovery.ps1') -Control $Control
    } else {
        $output = & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-runtime-completion.mjs') `
            $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
        if ($LASTEXITCODE -ne 0) { throw 'Cold runtime completion actor failed.' }
    }
    $result = ($output -join "`n") | ConvertFrom-Json
    $runtime = $result.completed.runtime
    $owner = [Diagnostics.Process]::GetProcessById($runtime.pid)
    $null = $owner.Handle
    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($owner.Id) -cne $runtime.identity -or
        [Deployment.WindowsRuntimeControl]::Exchange(
            [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'lease', 15000) -cne 'released') {
        throw 'Original cold runtime did not survive its controller with a released lease.'
    }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    $original = Get-Content -LiteralPath (Join-Path $Control 'task-maintenance/admission.json') -Raw | ConvertFrom-Json
    $before = [xml]$original.definition
    $after = [xml]$task.Xml
    $ns = [Xml.XmlNamespaceManager]::new($before.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    foreach ($name in @('RegistrationInfo', 'Triggers', 'Principals', 'Settings')) {
        if ($before.SelectSingleNode("/t:Task/t:$name", $ns).OuterXml -cne
            $after.SelectSingleNode("/t:Task/t:$name", $ns).OuterXml) {
            throw "Cold completion changed original $name policy."
        }
    }
    $originalEnabled = $before.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $ns)
    $enabled = -not $originalEnabled -or $originalEnabled.InnerText -ceq 'true'
    if ([bool]$task.Enabled -ne $enabled -or $task.GetInstances(0).Count -ne 1 -or
        [string]$task.GetSecurityDescriptor(7) -cne $original.securityDescriptor -or
        [string]$task.Xml -cne $result.completed.definition) {
        throw 'Cold completion lost original enabled policy, security or retained instance.'
    }
    $action = $task.Definition.Actions.Item(1)
    if ($task.Definition.Actions.Count -ne 1 -or $action.Arguments -match '-Controller(?:Pid|Identity)' -or
        $action.WorkingDirectory -cne (Split-Path $result.running.configuration) -or
        $action.Arguments -cne "-NoProfile -NonInteractive -File `"$(Join-Path $action.WorkingDirectory 'windows-runtime-host.ps1')`" -Configuration `"$($result.running.configuration)`" -Sha256 $($runtime.configurationSha256)") {
        throw 'Cold completion did not retain its permanent unguarded runtime action.'
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $runtime.pid `
        -OwnerIdentity $runtime.identity -Definition ([string]$task.Xml) -SecurityDescriptor $original.securityDescriptor
    if ($binding.instanceGuid -cne $runtime.instanceGuid -or $binding.sessionId -ne $runtime.sessionId) {
        throw 'Cold completion replaced its original Scheduler instance.'
    }
    $listener = [Deployment.WindowsRuntimeListener]::Retain(
        [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $result.completed.port)
    try { $listener.Check() } finally { $listener.Dispose() }
    Write-Output 'PASS: cold runtime survives original controller exit with released lease, original permanent task policy and unchanged transaction evidence'
    & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-completion-proof.mjs') `
        $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    if ($LASTEXITCODE -ne 0) { throw 'Independent cold completion observation failed.' }
    foreach ($attempt in @(1, 2)) {
        & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-cold-terminal.mjs') `
            $Control ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
        if ($LASTEXITCODE -ne 0) { throw 'Cold terminal handoff or independent reentry failed.' }
    }
} finally {
    if ($owner) {
        try {
            if (-not $owner.HasExited) {
                $stop = [Deployment.WindowsRuntimeControl]::Exchange(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'stop', 15000) | ConvertFrom-Json
                if (-not $stop.quiescent -or $stop.members.Count -ne 0 -or
                    [Deployment.WindowsRuntimeControl]::Exchange(
                        [guid]$runtime.generation, $runtime.pid, $runtime.identity, 'retire', 15000) -cne 'retired' -or
                    -not $owner.WaitForExit(15000)) { throw 'Cold completed runtime cleanup did not settle.' }
            }
            [Deployment.WindowsWorkerJob]::AssertRuntimeJobEmpty([guid]$runtime.generation, $runtime.sessionId)
        } finally { $owner.Dispose() }
    }
}
