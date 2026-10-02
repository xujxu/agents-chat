param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)][string]$Configuration,
    [Parameter(Mandatory)][string]$Sha256,
    [Parameter(Mandatory)]$Binding,
    [Parameter(Mandatory)][ValidateSet('close', 'exit', 'changed-state', 'retire', 'retire-refused',
        'replace', 'replace-refused', 'replace-early', 'replace-variable', 'replace-argument',
        'activate', 'activate-exit', 'activate-state-change', 'activate-readiness', 'activate-early',
        'activate-complete', 'activate-complete-changed-state')][string]$Action,
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
$stoppedDefinition = $null
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
    if (($Action.StartsWith('replace') -or $Action.StartsWith('activate')) -and $Restore) {
        $originalDescriptor = [string]$task.GetSecurityDescriptor(7)
        $custom = [Security.AccessControl.RawSecurityDescriptor]::new($originalDescriptor)
        $custom.DiscretionaryAcl.InsertAce(0, [Security.AccessControl.CommonAce]::new(
            [Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessDenied,
            [int]::MinValue, [Security.Principal.SecurityIdentifier]::new('S-1-5-7'), $false, $null))
        $task.SetSecurityDescriptor($custom.GetSddlForm([Security.AccessControl.AccessControlSections]::All), 16)
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        Assert ([string]$task.GetSecurityDescriptor(7) -cne $originalDescriptor) 'Fixture must exercise nondefault task permissions'
    }
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
    $stoppedDefinition = [string]$scheduler.GetFolder('\').GetTask($TaskName).Xml
    $request = @{ action=$Action }
    $replacement = $null
    if ($Action.StartsWith('replace') -or $Action -in @('activate', 'activate-exit', 'activate-state-change', 'activate-readiness',
        'activate-complete', 'activate-complete-changed-state')) {
        $original = [IO.File]::ReadAllText($Configuration) | ConvertFrom-Json -AsHashtable
        $candidateEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($key in $original.command.environment.Keys) { $candidateEnvironment.Add($key, $original.command.environment[$key]) }
        $candidateName = switch ($Action) {
            'replace-variable' { 'replacement%SystemRoot%' }
            'replace-argument' { 'replacement$(Arg0)' }
            default { 'replacement' }
        }
        $replacement = New-AgentsChatRuntimeBundle -Source ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))) `
            -Directory (Join-Path $controllerRoot $candidateName) -File $original.command.file `
            -Arguments ([string[]]$original.command.args) -WorkingDirectory $original.command.cwd -Environment $candidateEnvironment
        $request.configuration = $replacement.Configuration
        $request.sha256 = $replacement.Sha256
    }
    if ($Action -in @('activate', 'activate-exit', 'activate-state-change', 'activate-readiness',
        'activate-complete', 'activate-complete-changed-state')) {
        & (Join-Path $PSScriptRoot 'deployment-windows-task-activation-cases.ps1') `
            -Controller $controller -Bridge $bridge -OriginalOwner $Owner -OriginalReady $Ready `
            -Replacement $replacement -Request $request -Root $Root -Control $control -Directory $directory `
            -TaskName $TaskName -OperationId $hello.operationId -AdmissionSha256 $digest `
            -SecurityDescriptor $record.securityDescriptor
        return
    }
    $controller.StandardInput.WriteLine(($request | ConvertTo-Json -Compress))
    $controller.StandardInput.Flush()
    if ($Action -ne 'exit') { Assert ((Receive-Controller).phase -ceq 'closed') 'Node close was not acknowledged' }
    Assert ($controller.WaitForExit(15000) -and $controller.ExitCode -eq 0 -and
        $bridge.WaitForExit(15000)) 'Original Node controller or bridge survived completion'
    if ($Action -in @('retire', 'replace', 'replace-refused', 'replace-variable', 'replace-argument')) {
        Assert ($Owner.WaitForExit(15000) -and $Owner.ExitCode -eq 0) 'Original task owner did not retire cleanly'
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        Assert (-not $task.Enabled -and $task.GetInstances(0).Count -eq 0) 'Retirement released inhibition or left a task instance'
        $previous = (Get-FileHash -LiteralPath (Join-Path $directory 'task-stop-stopped.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $transactionHash = (Get-FileHash -LiteralPath (Join-Path $directory 'transaction.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $stateHash = (Get-FileHash -LiteralPath (Join-Path $control 'state.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        foreach ($phase in @('requested', 'complete')) {
            $file = Join-Path $directory "task-retire-$phase.json"
            $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
            try { $receipt = $retained.ReadText() | ConvertFrom-Json }
            finally { $retained.Dispose() }
            Assert ($receipt.version -eq 1 -and $receipt.phase -ceq $phase -and
                $receipt.previousSha256 -ceq $previous -and $receipt.admissionSha256 -ceq $digest -and
                $receipt.transactionSha256 -ceq $transactionHash -and $receipt.operationId -ceq $hello.operationId -and
                $receipt.taskName -ceq $TaskName -and $receipt.stateSha256 -ceq $stateHash -and
                $receipt.ownerPid -eq $Owner.Id -and $receipt.ownerIdentity -ceq $Ready.identity -and
                $receipt.generation -ceq $Ready.generation -and $receipt.instanceGuid -ceq $Binding.instanceGuid -and
                $receipt.definition -ceq $stoppedDefinition -and
                $receipt.securityDescriptor -ceq [string]$task.GetSecurityDescriptor(7) -and
                $receipt.statePhase -ceq $(if ($Restore) { 'restore-activating' } else { 'activating' })) `
                'Retirement evidence lost original authority or task policy'
            $previous = $hash
        }
        Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-retire-*.json').Count -eq 2 -and
            @(Get-ChildItem -LiteralPath $directory -Filter 'task-stop-*.json').Count -eq 4) 'Retirement duplicated or removed evidence'
        if ($Action -eq 'replace') {
            $definition = $task.Definition
            $actionDefinition = $definition.Actions.Item(1)
            $hostFile = Join-Path $replacement.Directory 'windows-runtime-host.ps1'
            $expectedArguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$($replacement.Configuration)`" -Sha256 $($replacement.Sha256)"
            Assert ($definition.Actions.Count -eq 1 -and
                [string]$actionDefinition.Path -ceq [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -and
                [string]$actionDefinition.Arguments -ceq $expectedArguments -and
                [string]$actionDefinition.WorkingDirectory -ceq $replacement.Directory) 'Replacement action is not the exact candidate'
            $before = [xml]$stoppedDefinition
            $after = [xml]$task.Xml
            $namespaces = [Xml.XmlNamespaceManager]::new($before.NameTable)
            $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
            foreach ($name in @('Command', 'Arguments', 'WorkingDirectory')) {
                foreach ($document in @($before, $after)) {
                    $nodes = $document.SelectNodes("/t:Task/t:Actions/t:Exec/t:$name", $namespaces)
                    Assert ($nodes.Count -eq 1) 'Replacement lost literal action fields'
                    $nodes[0].InnerText = 'normalized'
                }
            }
            Assert ($before.OuterXml -ceq $after.OuterXml) 'Replacement changed account, triggers, settings or unrelated task policy'
            foreach ($phase in @('requested', 'complete')) {
                $file = Join-Path $directory "task-replace-$phase.json"
                $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
                $retained = [Deployment.WindowsPrivateFile]::Open($file, $hash)
                try { $receipt = $retained.ReadText() | ConvertFrom-Json }
                finally { $retained.Dispose() }
                Assert ($receipt.version -eq 1 -and $receipt.phase -ceq $phase -and
                    $receipt.previousSha256 -ceq $previous -and $receipt.operationId -ceq $hello.operationId -and
                    $receipt.admissionSha256 -ceq $digest -and $receipt.transactionSha256 -ceq $transactionHash -and
                    $receipt.stateSha256 -ceq $stateHash -and $receipt.taskName -ceq $TaskName -and
                    $receipt.originalDefinition -ceq $stoppedDefinition -and
                    ([xml]$receipt.definition).OuterXml -ceq ([xml]$task.Xml).OuterXml -and
                    $receipt.securityDescriptor -ceq $record.securityDescriptor -and
                    $receipt.configuration -ceq $replacement.Configuration -and
                    $receipt.configurationSha256 -ceq $replacement.Sha256) 'Replacement receipts lost original authority or candidate binding'
                $previous = $hash
            }
            Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-replace-*.json').Count -eq 2 -and
                @(Get-ChildItem -LiteralPath $replacement.Directory -Filter 'runtime-*.json').Count -eq 0) `
                'Replacement duplicated evidence or started an unverified runtime'
            Write-Output 'PASS: update/restore replacement preserves disabled policy, account, triggers and permissions with exact private candidate receipts'
        } else {
            Assert ([string]$task.Xml -ceq $stoppedDefinition -and
                @(Get-ChildItem -LiteralPath $directory -Filter 'task-replace-*.json').Count -eq 0) `
                'Unaccepted replacement changed the task or published intent'
        }
        Write-Output 'PASS: transactional retirement joins only the original task owner and retains disabled policy and exact private receipts'
        return
    }
    Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-retire-*.json').Count -eq 0) `
        'Unaccepted retirement published intent'
    Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-activate-*.json').Count -eq 0) `
        'Unaccepted activation published intent'
    Assert (@(Get-ChildItem -LiteralPath $directory -Filter 'task-replace-*.json').Count -eq 0 -and
        [string]$scheduler.GetFolder('\').GetTask($TaskName).Xml -ceq $stoppedDefinition) `
        'Replacement before retirement changed the task or published intent'
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
