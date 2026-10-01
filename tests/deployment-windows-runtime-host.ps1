param([ValidateSet('stop', 'configuration-change', 'task-inhibition')][string]$Scenario = 'stop')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
$helpers = @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsRuntimeHost.cs',
    'windows-worker-launcher.ps1', 'windows-runtime-host.ps1')
Add-Type -Path @((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'),
    (Join-Path $source 'WindowsRuntimePipe.cs'), (Join-Path $source 'WindowsRuntimeControl.cs'),
    (Join-Path $source 'WindowsPrivateFile.cs'))
. (Join-Path $source 'windows-task-owner-binding.ps1')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Save-Configuration([string]$File, [string]$Text) {
    [IO.File]::WriteAllText($File, $Text, [Text.UTF8Encoding]::new($false))
    $security = Get-Acl -LiteralPath $File
    $security.SetOwner($sid)
    Set-Acl -LiteralPath $File -AclObject $security
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$node = (Get-Command node).Source
$taskName = "Agents-Chat-Runtime-Host-Test-$([guid]::NewGuid())"
$root = Join-Path ([IO.Path]::GetTempPath()) "$taskName space"
$registered = $false
$owner = $null
$member = $null
$unexpectedOwner = $null
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $root = & $node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $root
    Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize installed host fixture'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $root
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl',
            'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    $hashes = [ordered]@{}
    foreach ($name in $helpers) {
        $file = Join-Path $root $name
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $file
        $security = Get-Acl -LiteralPath $file
        $security.SetOwner($sid)
        Set-Acl -LiteralPath $file -AclObject $security
        $hashes[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    @'
const fs = require('node:fs');
if (process.argv[2] === 'child') {
  fs.writeFileSync('writer-pid', String(process.pid));
  fs.writeFileSync('writes', 'x');
  setInterval(() => fs.appendFileSync('writes', 'x'), 10);
} else {
  fs.writeFileSync('literal.json', JSON.stringify([process.argv[2], process.env.RUNTIME_LITERAL]));
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'child'],
    { detached: true, stdio: 'ignore' });
  child.unref();
}
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
    $configuration = [ordered]@{
        version=1
        helpers=$hashes
        command=[ordered]@{
            file=$node
            args=@((Join-Path $root 'writer.cjs'), 'literal %n $HOME " space')
            cwd=$root
            environment=[ordered]@{ SystemRoot=$env:SystemRoot; PATH=$env:PATH; RUNTIME_LITERAL='literal %n $HOME " space' }
        }
    }
    $configFile = Join-Path $root 'configuration.json'
    $hostFile = Join-Path $root 'windows-runtime-host.ps1'
    $text = $configuration | ConvertTo-Json -Depth 8 -Compress
    foreach ($mode in @('digest', 'duplicate', 'unknown', 'environment', 'helper')) {
        $candidate = $text
        if ($mode -eq 'duplicate') { $candidate = $text.Replace('"version":1', '"version":1,"version":1') }
        if ($mode -eq 'unknown') { $candidate = $text.Replace('"version":1', '"version":1,"unknown":true') }
        if ($mode -eq 'environment') { $candidate = $text.Replace('"RUNTIME_LITERAL":', '"path":"unexpected","RUNTIME_LITERAL":') }
        if ($mode -eq 'helper') { $candidate = $text.Replace($hashes['windows-worker-launcher.ps1'], ('0' * 64)) }
        $digest = Save-Configuration $configFile $candidate
        if ($mode -eq 'digest') { $digest = '0' * 64 }
        $stage = switch ($mode) { 'helper' { 'helpers' } 'environment' { 'command' } default { 'configuration' } }
        $output = & $pwsh -NoProfile -NonInteractive -File $hostFile -Configuration $configFile -Sha256 $digest 2>&1
        Assert ($LASTEXITCODE -ne 0 -and ($output -join "`n") -match "Managed runtime startup refused: $stage\.") "Unsupported $mode configuration was not explicitly refused"
        Assert (-not (Test-Path -LiteralPath (Join-Path $root 'writes')) -and
            @(Get-ChildItem -LiteralPath $root -Filter 'runtime-*.json').Count -eq 0) 'Refused startup published readiness or admitted target work'
        $global:LASTEXITCODE = 0
    }
    Write-Output 'PASS: installed host rejects wrong configuration digest, duplicate fields and changed helper content before admission'
    $digest = Save-Configuration $configFile $text
    $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $root -Argument (
        "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$configFile`" -Sha256 $digest")
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
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
    Remove-Item -LiteralPath $root -Recurse -Force
}
