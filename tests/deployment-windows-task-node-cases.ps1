param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)]$Binding,
    [Parameter(Mandatory)][ValidateSet('close', 'exit', 'changed-state', 'retire', 'retire-refused')][string]$Action,
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
$node = (Get-Command node).Source
$node = & $node -p "require('node:fs').realpathSync.native(process.execPath)"
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize task controller executable'
$fixture = if ($Transactional) { 'deployment-windows-task-transaction-controller.mjs' } else { 'deployment-windows-task-controller.mjs' }
$arguments = [Collections.Generic.List[string]]::new()
$arguments.Add((Join-Path $PSScriptRoot $fixture))
$arguments.Add([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
$control = $null
if ($Transactional) {
    $control = "$Root-control"
    $arguments.Add($control)
    $arguments.Add($Root)
    $arguments.Add($(if ($Restore) { 'restore' } else { 'update' }))
}
$controllerRoot = if ($Transactional) { $control } else { "$Root-controller" }
$environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$environment.Add('SystemRoot', $env:SystemRoot)
$environment.Add('TEMP', $controllerRoot)
$environment.Add('TMP', $controllerRoot)
$powershellDirectory = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'
Assert (Test-Path -LiteralPath (Join-Path $powershellDirectory 'powershell.exe')) 'System process-identity tool is missing'
$environment.Add('PATH', $powershellDirectory)
$controller = $null
$diagnostic = $null
$bridge = $null
$controllerDirectory = [Deployment.WindowsPrivateFile]::CreateDirectory($controllerRoot)
try {
    try {
        $controller = [Deployment.WindowsControllerProcess]::Start($node, $arguments.ToArray(), $controllerRoot, $environment)
    } finally { $controllerDirectory.Dispose() }
    $diagnostic = $controller.StandardError.ReadToEndAsync()
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
    $directory = Join-Path $controllerRoot $(if ($Transactional) { 'task-maintenance' } else { 'node-maintenance' })
    $maintenanceDirectory = [Deployment.WindowsPrivateFile]::CreateDirectory($directory)
    $maintenanceDirectory.Dispose()
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
    if ($Action -eq 'retire') {
        Assert ($Owner.WaitForExit(15000) -and $Owner.ExitCode -eq 0) 'Original task owner did not retire cleanly'
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        Assert (-not $task.Enabled -and $task.GetInstances(0).Count -eq 0) 'Retirement released inhibition or left a task instance'
        $previous = (Get-FileHash -LiteralPath (Join-Path $directory 'task-stop-stopped.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $transactionHash = (Get-FileHash -LiteralPath (Join-Path $directory 'transaction.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        foreach ($phase in @('requested', 'complete')) {
            $file = Join-Path $directory "task-retire-$phase.json"
            $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
            try { $receipt = $retained.ReadText() | ConvertFrom-Json }
            finally { $retained.Dispose() }
            Assert ($receipt.version -eq 1 -and $receipt.phase -ceq $phase -and
                $receipt.previousSha256 -ceq $previous -and $receipt.admissionSha256 -ceq $digest -and
                $receipt.transactionSha256 -ceq $transactionHash -and $receipt.operationId -ceq $hello.operationId -and
                $receipt.ownerPid -eq $Owner.Id -and $receipt.ownerIdentity -ceq $Ready.identity -and
                $receipt.generation -ceq $Ready.generation -and $receipt.instanceGuid -ceq $Binding.instanceGuid -and
                $receipt.definition -ceq [string]$task.Xml -and
                $receipt.securityDescriptor -ceq [string]$task.GetSecurityDescriptor(7) -and
                $receipt.statePhase -ceq $(if ($Restore) { 'restore-activating' } else { 'activating' })) `
                'Retirement evidence lost original authority or task policy'
            $previous = $hash
        }
        Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-retire-*.json').Count -eq 2 -and
            @(Get-ChildItem -LiteralPath $directory -Filter 'task-stop-*.json').Count -eq 4) 'Retirement duplicated or removed evidence'
        Write-Output 'PASS: transactional retirement joins only the original task owner and retains disabled policy and exact private receipts'
        return
    }
    Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-retire-*.json').Count -eq 0) `
        'Unaccepted retirement published intent'
    Assert (-not $Owner.HasExited -and -not $scheduler.GetFolder('\').GetTask($TaskName).Enabled) `
        'Node completion retired the original task owner or released inhibition'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$Ready.generation, $Ready.pid, $Ready.identity, 'observe', 15000) | ConvertFrom-Json
    Assert ($observation.quiescent -and $observation.phase -ceq 'stopped' -and
        $observation.members.Count -eq 0 -and
        @(Get-ChildItem -LiteralPath $directory -Filter 'task-stop-*.json').Count -eq 4) `
        'Node completion lost original stopped domain or durable evidence'
    Write-Output "PASS: private production Node controller $Action preserves native inhibition, original task owner and durable stopped evidence"
} finally {
    if ($controller) {
        try {
            $controller.Kill()
            Assert ($controller.WaitForExit(15000)) 'Generated Node controller failed to exit'
            if ($bridge) {
                Assert ($bridge.WaitForExit(15000)) 'Generated native bridge outlived its original Node controller'
            }
            if ($diagnostic) {
                Assert ($diagnostic.Wait(15000)) 'Node controller diagnostics did not close'
                $text = $diagnostic.GetAwaiter().GetResult()
                if ($text) { [Console]::Error.WriteLine($text) }
            }
        } finally { $controller.Dispose() }
        Remove-Item -LiteralPath $controllerRoot -Recurse -Force
    }
    if ($bridge) { $bridge.Dispose() }
}
