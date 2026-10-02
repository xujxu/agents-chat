param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)]$Binding,
    [Parameter(Mandatory)][ValidateSet('close', 'exit', 'changed-state')][string]$Action,
    [switch]$Transactional,
    [switch]$Restore
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Receive-Controller {
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($controller.StandardOutput, 4096)
    Assert ($line.Wait(60000)) 'Node controller did not reply'
    return $line.GetAwaiter().GetResult() | ConvertFrom-Json
}
$info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$fixture = if ($Transactional) { 'deployment-windows-task-transaction-controller.mjs' } else { 'deployment-windows-task-controller.mjs' }
$info.ArgumentList.Add((Join-Path $PSScriptRoot $fixture))
$info.ArgumentList.Add([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
$control = $null
if ($Transactional) {
    $control = "$Root-control"
    New-Item -ItemType Directory -Path $control | Out-Null
    & (Join-Path $PSScriptRoot 'deployment-windows-private-control.ps1') -Control $control
    $info.ArgumentList.Add($control)
    $info.ArgumentList.Add($Root)
    $info.ArgumentList.Add($(if ($Restore) { 'restore' } else { 'update' }))
}
$controller = [Diagnostics.Process]::Start($info)
$null = $controller.Handle
$diagnostic = $controller.StandardError.ReadToEndAsync()
$bridge = $null
try {
    $hello = Receive-Controller
    Assert ($hello.pid -eq $controller.Id -and
        $hello.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($controller.Id)) 'Node controller identity differs'
    if ($Transactional) {
        $lockFile = Join-Path $control 'lock/owner.json'
        $lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $privateLock = [Deployment.WindowsPrivateFile]::Open($lockFile, $lockHash)
        try {
            Assert (($privateLock.ReadText() | ConvertFrom-Json).pid -eq $controller.Id) `
                'Fresh private transaction lock belongs to another controller'
        } finally { $privateLock.Dispose() }
    }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    $readyFile = Join-Path $Root "runtime-$($Ready.identity.Replace(':', '-')).json"
    $directory = if ($Transactional) { Join-Path $control 'task-maintenance' } else { Join-Path $Root 'node-maintenance' }
    New-Item -ItemType Directory -Path $directory | Out-Null
    $security = Get-Acl -LiteralPath $directory
    $security.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    Set-Acl -LiteralPath $directory -AclObject $security
    $record = [ordered]@{
        version=1; operationId=$(if ($Transactional) { $hello.operationId } else { [guid]::NewGuid().ToString('D') })
        controllerPid=$hello.pid; controllerIdentity=$hello.identity
        taskName=$TaskName; definition=[string]$task.Xml; securityDescriptor=[string]$task.GetSecurityDescriptor(7)
        configuration=$Configuration; configurationSha256=$Sha256
        readySha256=(Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
        ownerPid=$Owner.Id; ownerIdentity=$Ready.identity; generation=$Ready.generation; instanceGuid=$Binding.instanceGuid
    }
    $file = Join-Path $directory 'admission.json'
    $published = [Deployment.WindowsPrivateFile]::Publish($file, ($record | ConvertTo-Json -Depth 8 -Compress))
    try { $digest = $published.Sha256 }
    finally { $published.Dispose() }
    $controller.StandardInput.WriteLine((@{ admission=$file; sha256=$digest } | ConvertTo-Json -Compress))
    $controller.StandardInput.Flush()
    $stopped = Receive-Controller
    Assert ($stopped.phase -ceq 'stopped') 'Node controller did not retain stopped authority'
    $bridge = [Diagnostics.Process]::GetProcessById([int]$stopped.bridge.pid)
    $null = $bridge.Handle
    Assert ($stopped.bridge.processIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($bridge.Id)) `
        'Native bridge process identity differs'
    $controller.StandardInput.WriteLine((@{ action=$Action } | ConvertTo-Json -Compress))
    $controller.StandardInput.Flush()
    if ($Action -ne 'exit') { Assert ((Receive-Controller).phase -ceq 'closed') 'Node close was not acknowledged' }
    Assert ($controller.WaitForExit(15000) -and $controller.ExitCode -eq 0 -and
        $bridge.WaitForExit(15000)) 'Original Node controller or bridge survived completion'
    Assert (-not $Owner.HasExited -and -not $scheduler.GetFolder('\').GetTask($TaskName).Enabled) `
        'Node completion retired the original task owner or released inhibition'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$Ready.generation, $Ready.pid, $Ready.identity, 'observe', 15000) | ConvertFrom-Json
    Assert ($observation.quiescent -and $observation.phase -ceq 'stopped' -and
        $observation.members.Count -eq 0 -and
        @(Get-ChildItem -LiteralPath $directory -Filter 'task-stop-*.json').Count -eq 4) `
        'Node completion lost original stopped domain or durable evidence'
    Write-Output "PASS: Node controller $Action preserves native inhibition, original task owner and durable stopped evidence"
} finally {
    if (-not $controller.HasExited) { $controller.Kill() }
    Assert ($controller.WaitForExit(15000)) 'Generated Node controller failed to exit'
    if ($bridge) {
        Assert ($bridge.WaitForExit(15000)) 'Generated native bridge outlived its original Node controller'
        $bridge.Dispose()
    }
    Assert ($diagnostic.Wait(15000)) 'Node controller diagnostics did not close'
    $text = $diagnostic.GetAwaiter().GetResult()
    if ($text) { [Console]::Error.WriteLine($text) }
    $controller.Dispose()
    if ($control) { Remove-Item -LiteralPath $control -Recurse -Force }
}
