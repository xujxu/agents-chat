param([ValidateSet('stop', 'configuration-change', 'task-inhibition', 'durable-stop', 'node-close', 'node-exit',
    'transaction-close', 'transaction-exit', 'transaction-changed-state', 'transaction-restore',
    'transaction-retire', 'transaction-retire-refused', 'transaction-retire-restore',
    'transaction-replace', 'transaction-replace-restore', 'transaction-replace-refused', 'transaction-replace-early',
    'transaction-replace-variable', 'transaction-replace-argument',
    'transaction-activate', 'transaction-activate-restore', 'transaction-activate-exit', 'transaction-activate-early',
    'transaction-activate-state-change', 'transaction-activate-readiness',
    'transaction-activate-complete', 'transaction-activate-complete-restore', 'transaction-activate-complete-changed-state',
    'transaction-activate-complete-disabled',
    'transaction-activate-complete-proof', 'transaction-activate-complete-proof-restore', 'transaction-activate-complete-proof-disabled',
    'guarded-owner-exit', 'guarded-release', 'listener-v4', 'listener-v6', 'listener-independent-pair')][string]$Scenario = 'stop')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))
$helpers = @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs',
    'windows-worker-launcher.ps1', 'windows-runtime-host.ps1')
$observerHelpers = @(if ($Scenario.StartsWith('listener-')) { Join-Path $source 'WindowsRuntimeListener.cs' })
Add-Type -Path (@((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'),
    (Join-Path $source 'WindowsRuntimePipe.cs'), (Join-Path $source 'WindowsRuntimeControl.cs'),
    (Join-Path $source 'WindowsPrivateFile.cs'), (Join-Path $source 'WindowsRuntimeLease.cs'), (Join-Path $source 'WindowsRuntimeHost.cs'),
    (Join-Path $source 'WindowsControllerToken.cs'),
    (Join-Path $source 'WindowsControllerProcess.cs')) + $observerHelpers)
. (Join-Path $source 'windows-task-owner-binding.ps1')
. (Join-Path $source 'windows-runtime-bundle.ps1')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Save-Configuration([string]$File, [string]$Text) {
    [IO.File]::WriteAllText($File, $Text, [Text.UTF8Encoding]::new($false))
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$node = (Get-Command node).Source
$taskName = "Agents-Chat-Runtime-Host-Test-$([guid]::NewGuid())"
$parent = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" ([IO.Path]::GetTempPath())
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize installed host fixture parent'
$root = Join-Path $parent "$taskName space"
$registered = $false
$owner = $null
$member = $null
$unexpectedOwner = $null
$guardController = $null
$guardDiagnostic = $null
try {
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $environment.Add('SystemRoot', $env:SystemRoot)
    $environment.Add('PATH', $env:PATH)
    $environment.Add('RUNTIME_LITERAL', 'literal %n $HOME " space')
    if ($Scenario.StartsWith('listener-') -or $Scenario -ceq 'transaction-activate-readiness' -or $Scenario.StartsWith('transaction-activate-complete')) {
        $address = switch ($Scenario) { 'listener-v4' { '127.0.0.1' } 'listener-v6' { '::' } default { 'independent' } }
        if ($Scenario -ceq 'transaction-activate-readiness' -or $Scenario.StartsWith('transaction-activate-complete')) { $address = '127.0.0.1' }
        $environment.Add('RUNTIME_LISTENER_ADDRESS', $address)
    }
    $bundle = New-AgentsChatRuntimeBundle -Source $source -Directory $root -File $node `
        -Arguments @((Join-Path $root 'writer.cjs'), 'literal %n $HOME " space') `
        -WorkingDirectory $root -Environment $environment
    $configFile = $bundle.Configuration
    $text = [IO.File]::ReadAllText($configFile)
    $configuration = $text | ConvertFrom-Json -AsHashtable
    $hashes = $configuration.helpers
    Assert (($hashes.Keys | Sort-Object | ConvertTo-Json -Compress) -ceq ($helpers | Sort-Object | ConvertTo-Json -Compress)) `
        'Production bundle helper inventory differs from installed host contract'
    foreach ($name in $helpers) {
        $retained = [Deployment.WindowsPrivateFile]::Open((Join-Path $root $name), $hashes[$name])
        try { $retained.Check() }
        finally { $retained.Dispose() }
    }
    if ($Scenario.StartsWith('listener-') -or $Scenario -ceq 'transaction-activate-readiness' -or $Scenario.StartsWith('transaction-activate-complete')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deployment-windows-runtime-listener.cjs') -Destination (Join-Path $root 'listener-fixture.cjs')
    }
    @'
const fs = require('node:fs');
if (process.argv[2] === 'child') {
  fs.writeFileSync('writer-pid', String(process.pid));
  fs.writeFileSync('writes', 'x');
  setInterval(() => fs.appendFileSync('writes', 'x'), 10);
  if (process.env.RUNTIME_LISTENER_ADDRESS) require('./listener-fixture.cjs')();
} else {
  fs.writeFileSync('literal.json', JSON.stringify([process.argv[2], process.env.RUNTIME_LITERAL]));
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'child'],
    { detached: true, stdio: 'ignore' });
  child.unref();
}
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
    $hostFile = Join-Path $root 'windows-runtime-host.ps1'
    foreach ($mode in @('digest', 'duplicate', 'unknown', 'environment', 'helper', 'controller')) {
        $candidate = $text
        if ($mode -eq 'duplicate') { $candidate = $text.Replace('"version":1', '"version":1,"version":1') }
        if ($mode -eq 'unknown') { $candidate = $text.Replace('"version":1', '"version":1,"unknown":true') }
        if ($mode -eq 'environment') { $candidate = $text.Replace('"RUNTIME_LITERAL":', '"path":"unexpected","RUNTIME_LITERAL":') }
        if ($mode -eq 'helper') { $candidate = $text.Replace($hashes['windows-worker-launcher.ps1'], ('0' * 64)) }
        $digest = Save-Configuration $configFile $candidate
        if ($mode -eq 'digest') { $digest = '0' * 64 }
        $stage = switch ($mode) {
            'helper' { 'helpers' } 'environment' { 'command' } 'controller' { 'activation-lease' } default { 'configuration' }
        }
        $output = if ($mode -ceq 'controller') {
            & $pwsh -NoProfile -NonInteractive -File $hostFile -Configuration $configFile -Sha256 $digest `
                -ControllerPid $PID -ControllerIdentity '1:1' 2>&1
        } else {
            & $pwsh -NoProfile -NonInteractive -File $hostFile -Configuration $configFile -Sha256 $digest 2>&1
        }
        Assert ($LASTEXITCODE -ne 0 -and ($output -join "`n") -match "Managed runtime startup refused: $stage\.") "Unsupported $mode configuration was not explicitly refused"
        Assert (-not (Test-Path -LiteralPath (Join-Path $root 'writes')) -and
            @(Get-ChildItem -LiteralPath $root -Filter 'runtime-*.json').Count -eq 0) 'Refused startup published readiness or admitted target work'
        $global:LASTEXITCODE = 0
    }
    Write-Output 'PASS: installed host rejects wrong configuration digest, duplicate fields and changed helper content before admission'
    $digest = Save-Configuration $configFile $text
    $taskArguments = "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$configFile`" -Sha256 $digest"
    if ($Scenario.StartsWith('guarded-')) {
        $controllerRoot = Join-Path $root 'activation-controller'
        [Deployment.WindowsPrivateFile]::CreateDirectory($controllerRoot).Dispose()
        $controllerEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $controllerEnvironment.Add('SystemRoot', $env:SystemRoot)
        $controllerEnvironment.Add('TEMP', $controllerRoot)
        $controllerEnvironment.Add('TMP', $controllerRoot)
        $guardController = [Deployment.WindowsControllerProcess]::Start($pwsh,
            @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'deployment-windows-runtime-lease-client.ps1'),
                '-Role', 'owner'), $controllerRoot, $controllerEnvironment)
        $guardDiagnostic = $guardController.StandardError.ReadToEndAsync()
        $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($guardController.StandardOutput, 4096)
        Assert ($read.Wait(15000)) 'Activation controller did not announce its identity'
        $hello = $read.GetAwaiter().GetResult() | ConvertFrom-Json
        Assert ($hello.pid -eq $guardController.Id -and
            $hello.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($guardController.Id)) 'Activation controller identity differs'
        $taskArguments += " -ControllerPid $($hello.pid) -ControllerIdentity $($hello.identity)"
    }
    $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $root -Argument $taskArguments
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    if ($Scenario.StartsWith('transaction-activate')) {
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
            -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
        $trigger = New-ScheduledTaskTrigger -AtStartup
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Trigger $trigger | Out-Null
    } else {
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    }
    $registered = $true
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $task = $scheduler.GetFolder('\').GetTask($taskName)
        $instances = $task.GetInstances(0)
        Assert ([DateTime]::UtcNow -lt $deadline) 'Installed host task did not start'
        if ($instances.Count -ne 1) { Start-Sleep -Milliseconds 100 }
    } while ($instances.Count -ne 1)
    $owner = [Diagnostics.Process]::GetProcessById([int]$instances.Item(1).EnginePID)
    $null = $owner.Handle
    $ownerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($owner.Id)
    $readyFile = Join-Path $root "runtime-$($ownerIdentity.Replace(':', '-')).json"
    while (-not (Test-Path -LiteralPath $readyFile) -or -not (Test-Path -LiteralPath (Join-Path $root 'writes'))) {
        Assert (-not $owner.HasExited -and [DateTime]::UtcNow -lt $deadline) 'Installed runtime failed before readiness'
        Start-Sleep -Milliseconds 100
    }
    $readyHash = (Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($readyFile, $readyHash)
    try { $ready = $retained.ReadText() | ConvertFrom-Json }
    finally { $retained.Dispose() }
    Assert ($ready.version -eq 1 -and $ready.pid -eq $owner.Id -and $ready.identity -ceq $ownerIdentity -and
        $ready.configurationSha256 -ceq $digest -and $ready.sessionId -eq 0) 'Managed readiness lost configuration or original task-owner identity'
    if ($Scenario -cin @('transaction-activate-complete-disabled', 'transaction-activate-complete-proof-disabled')) {
        $task.Enabled = $false
        $task = $scheduler.GetFolder('\').GetTask($taskName)
    }
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $taskName -OwnerPid $owner.Id -OwnerIdentity $ownerIdentity `
        -Definition ([string]$task.Xml) -SecurityDescriptor ([string]$task.GetSecurityDescriptor(7))
    Assert ($binding.ownerPid -eq $ready.pid) 'Managed host is not the declared native task owner'
    $member = [Diagnostics.Process]::GetProcessById([int](Get-Content -LiteralPath (Join-Path $root 'writer-pid') -Raw))
    $null = $member.Handle
    $literal = Get-Content -LiteralPath (Join-Path $root 'literal.json') -Raw | ConvertFrom-Json
    Assert ($literal.Count -eq 2 -and $literal[0] -ceq 'literal %n $HOME " space' -and
        $literal[1] -ceq $literal[0]) 'Installed command reinterpreted literal argv or environment'
    foreach ($file in @($configFile, (Join-Path $root 'windows-worker-launcher.ps1'), $readyFile)) {
        $refused = $false
        try { [IO.File]::WriteAllText($file, 'changed') }
        catch { $refused = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32 }
        Assert $refused 'Installed runtime released its original configuration, helper or readiness file'
    }
    $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'observe', 15000) | ConvertFrom-Json
    Assert ($observation.members -contains $member.Id -and -not $observation.quiescent -and
        -not $observation.applicationHealthy) 'Managed host lost detached ownership or invented application health'
    if (-not $Scenario.StartsWith('guarded-')) {
        Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
            $ready.pid, $ready.identity, 'lease', 15000) -ceq 'unguarded') 'Unguarded production host invented an activation lease'
        $refused = $false
        try { [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'release', 15000) | Out-Null }
        catch { $refused = $_.Exception.GetBaseException().Message -ceq 'Runtime control request was refused.' }
        Assert ($refused -and -not $owner.HasExited -and -not $member.HasExited) 'Unguarded runtime accepted activation release'
    }
    if ($Scenario.StartsWith('guarded-')) {
        Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
            $ready.pid, $ready.identity, 'lease', 15000) -ceq 'guarded') 'Read-only observation lost the original activation lease'
        $refused = $false
        try { [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'release', 15000) | Out-Null }
        catch { $refused = $_.Exception.GetBaseException().Message -ceq 'Runtime control request was refused.' }
        Assert ($refused -and -not $owner.HasExited -and -not $member.HasExited) 'A different native peer released or destroyed the runtime lease'
        Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
            $ready.pid, $ready.identity, 'lease', 15000) -ceq 'guarded') 'Read-only observation or refused peer released the lease'
        if ($Scenario -ceq 'guarded-release') {
            foreach ($attempt in @(1, 2)) {
                $guardController.StandardInput.WriteLine((@{ method='release-runtime'; generation=$ready.generation
                    ownerPid=$ready.pid; ownerIdentity=$ready.identity } | ConvertTo-Json -Compress))
                $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($guardController.StandardOutput, 4096)
                Assert ($read.Wait(15000)) 'Original controller release was not acknowledged'
                Assert (($read.GetAwaiter().GetResult() | ConvertFrom-Json).value -ceq 'released') 'Original controller release reply differs'
                Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
                    $ready.pid, $ready.identity, 'lease', 15000) -ceq 'released') 'Actual original-peer release is not observable'
            }
        }
        $guardController.StandardInput.WriteLine('{"method":"exit"}')
        Assert ($guardController.WaitForExit(15000) -and $guardController.ExitCode -eq 0) 'Original activation controller failed to exit'
        if ($Scenario -ceq 'guarded-owner-exit') {
            Assert ($owner.WaitForExit(15000) -and $owner.ExitCode -eq 1 -and $member.WaitForExit(15000)) `
                'Unverified runtime or its original detached Job member outlived controller exit'
        } else {
            Start-Sleep -Milliseconds 500
            Assert (-not $owner.HasExited -and -not $member.HasExited) 'Released original runtime died with its controller'
            Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
                $ready.pid, $ready.identity, 'lease', 15000) -ceq 'released') 'New observer lost released state after original controller exit'
            $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
                $ready.pid, $ready.identity, 'observe', 15000) | ConvertFrom-Json
            Assert ($observation.members -contains $member.Id -and -not $observation.quiescent -and
                -not $observation.applicationHealthy) 'Lease release changed ownership or invented application health'
            $null = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'stop', 15000)
            Assert ($member.WaitForExit(15000)) 'Released runtime failed its ordinary owned stop'
            Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
                $ready.pid, $ready.identity, 'lease', 15000) -ceq 'released') 'Job stop changed historical lease release'
            $reply = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'retire', 15000)
            Assert ($reply -ceq 'retired' -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) 'Released runtime failed ordinary retirement'
        }
        Write-Output "PASS: $Scenario binds actual release peer and preserves original runtime Job ownership across controller exit"
        return
    }
    if ($Scenario.StartsWith('listener-')) {
        & (Join-Path $PSScriptRoot 'deployment-windows-runtime-listener-cases.ps1') -Root $root -Ready $ready -Owner $owner -Scenario $Scenario
    }
    if ($Scenario -eq 'durable-stop') {
        & (Join-Path $PSScriptRoot 'deployment-windows-task-maintenance-cases.ps1') -Root $root -TaskName $taskName `
            -Owner $owner -Ready $ready -Configuration $configFile -Sha256 $digest -Binding $binding
    }
    if ($Scenario -in @('node-close', 'node-exit')) {
        & (Join-Path $PSScriptRoot 'deployment-windows-task-node-cases.ps1') -Root $root -TaskName $taskName `
            -Owner $owner -Ready $ready -Configuration $configFile -Sha256 $digest -Binding $binding `
            -Action $Scenario.Substring(5)
    }
    if ($Scenario.StartsWith('transaction-')) {
        $restoreTransaction = $Scenario -in @('transaction-restore', 'transaction-retire-restore', 'transaction-replace-restore',
            'transaction-activate-restore', 'transaction-activate-complete-restore', 'transaction-activate-complete-proof-restore')
        $transactionAction = if ($Scenario -eq 'transaction-restore') { 'close' } `
            elseif ($Scenario -eq 'transaction-retire-restore') { 'retire' } `
            elseif ($Scenario -eq 'transaction-replace-restore') { 'replace' } `
            elseif ($Scenario -eq 'transaction-activate-restore') { 'activate' } `
            elseif ($Scenario.StartsWith('transaction-activate-complete-proof')) { 'activate-complete-proof' } `
            elseif ($Scenario -in @('transaction-activate-complete-restore', 'transaction-activate-complete-disabled')) { 'activate-complete' } else { $Scenario.Substring(12) }
        & (Join-Path $PSScriptRoot 'deployment-windows-task-node-cases.ps1') -Root $root -TaskName $taskName `
            -Owner $owner -Ready $ready -Configuration $configFile -Sha256 $digest -Binding $binding `
            -Action $transactionAction -Transactional -Restore:$restoreTransaction
        if ($transactionAction -in @('retire', 'replace', 'replace-refused', 'replace-variable', 'replace-argument',
            'activate', 'activate-exit', 'activate-state-change', 'activate-readiness', 'activate-complete', 'activate-complete-changed-state',
            'activate-complete-proof')) {
            Assert ($owner.HasExited -and $member.WaitForExit(15000) -and
                -not $scheduler.GetFolder('\').GetTask($taskName).Enabled) 'Transactional retirement lost original settlement'
            Write-Output "PASS: $Scenario retains durable retirement and original task inhibition"
            return
        }
    }
    if ($Scenario -eq 'task-inhibition') {
        $expected = [xml]$task.Xml
        $descriptor = [string]$task.GetSecurityDescriptor(7)
        Assert ([bool]$task.Enabled) 'Expected an enabled fixture task'
        $namespaces = [Xml.XmlNamespaceManager]::new($expected.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $enabledBefore = $expected.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        Assert ($enabledBefore.Count -le 1) 'Ambiguous original enabled policy'
        if ($enabledBefore.Count) {
            Assert ($enabledBefore[0].InnerText -ceq 'true') 'Original enabled XML differs from native state'
            $null = $enabledBefore[0].ParentNode.RemoveChild($enabledBefore[0])
        }
        $task.Enabled = $false
        $task = $scheduler.GetFolder('\').GetTask($taskName)
        $actual = [xml]$task.Xml
        $enabledAfter = $actual.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        Assert ($enabledAfter.Count -eq 1 -and $enabledAfter[0].InnerText -ceq 'false') 'Disabled task did not persist explicit inhibition'
        $null = $enabledAfter[0].ParentNode.RemoveChild($enabledAfter[0])
        Assert (-not $task.Enabled -and $actual.OuterXml -ceq $expected.OuterXml -and
            [string]$task.GetSecurityDescriptor(7) -ceq $descriptor) 'Native task inhibition changed unrelated policy'
        $instances = $task.GetInstances(0)
        Assert ($instances.Count -eq 1) 'Disabling the task lost the original running instance'
        $instance = $instances.Item(1)
        $instance.Refresh()
        Write-Output "TASK-INHIBITION-PROBE: task-state=$($task.State) instance-state=$($instance.State) enabled=$($task.Enabled)"
        $inhibited = Get-AgentsChatTaskOwnerBinding -TaskName $taskName -OwnerPid $owner.Id -OwnerIdentity $ownerIdentity `
            -Definition ([string]$task.Xml) -SecurityDescriptor $descriptor
        Assert (-not $inhibited.enabled -and $inhibited.instanceGuid -ceq $binding.instanceGuid) 'Inhibition lost original owner binding'
    }
    if ($Scenario -eq 'configuration-change') {
        $changed = Get-Acl -LiteralPath $configFile
        $changed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
        Set-Acl -LiteralPath $configFile -AclObject $changed
        $refused = $false
        try { [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'observe', 15000) | Out-Null }
        catch { $refused = $true }
        Assert ($refused -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 1 -and
            $member.WaitForExit(10000)) 'Changed private configuration retained command authority or leaked original Job members'
        Write-Output 'PASS: changed installed configuration refuses control and settles only the original owned Job'
    } else {
        $stopped = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'stop', 15000) | ConvertFrom-Json
        Assert ($stopped.quiescent -and $stopped.members.Count -eq 0 -and $member.WaitForExit(10000)) 'Managed host did not settle the original Job'
        $retired = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation, $ready.pid, $ready.identity, 'retire', 15000)
        Assert ($retired -ceq 'retired' -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) 'Managed host did not retire cleanly'
        if ($Scenario -eq 'task-inhibition') {
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                $task = $scheduler.GetFolder('\').GetTask($taskName)
                $instances = $task.GetInstances(0)
                Assert ([DateTime]::UtcNow -lt $deadline) 'Retired inhibited task retained a native instance'
                if ($instances.Count) { Start-Sleep -Milliseconds 100 }
            } while ($instances.Count)
            $unexpected = $null
            $code = $null
            try { $unexpected = $task.Run($null) }
            catch { $code = '{0:X8}' -f $_.Exception.GetBaseException().HResult }
            if ($unexpected) {
                $deadline = [DateTime]::UtcNow.AddSeconds(10)
                do {
                    $unexpected.Refresh()
                    if ([int]$unexpected.EnginePID -gt 0) {
                        $unexpectedOwner = [Diagnostics.Process]::GetProcessById([int]$unexpected.EnginePID)
                        $null = $unexpectedOwner.Handle
                        break
                    }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $deadline)
            }
            Assert ($code -ceq '80041326') "Disabled native task did not refuse explicit restart with SCHED_E_TASK_DISABLED: $code"
            Assert (-not $task.Enabled -and $task.GetInstances(0).Count -eq 0) 'Disabled task restarted after original owner retirement'
            Write-Output 'PASS: native inhibition preserves original owner settlement and refuses restart after retirement'
        }
    }
    Assert (Test-Path -LiteralPath $readyFile) 'Host silently deleted durable original-instance evidence'
    Write-Output "PASS: $Scenario actual installed S4U host binds private configuration, retained helpers and readiness, literal command and original Job settlement"
} finally {
    if ($registered) { Stop-ScheduledTask -TaskName $taskName }
    if ($owner) {
        Assert ($owner.WaitForExit(15000)) 'Installed task owner did not exit during cleanup'
        $owner.Dispose()
    }
    if ($unexpectedOwner) {
        Assert ($unexpectedOwner.WaitForExit(15000)) 'Unexpected generated task owner did not exit during cleanup'
        $unexpectedOwner.Dispose()
    }
    if ($member) {
        Assert ($member.WaitForExit(15000)) 'Installed detached member survived original owner cleanup'
        $member.Dispose()
    }
    if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    if ($guardController) {
        try {
            $guardController.Kill()
            Assert ($guardController.WaitForExit(15000) -and $guardDiagnostic.Wait(15000)) 'Activation controller did not settle'
            $text = $guardDiagnostic.GetAwaiter().GetResult()
            if ($text) { [Console]::Error.WriteLine($text) }
        } finally { $guardController.Dispose() }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
