param(
    [Parameter(Mandatory)]$Controller,
    [Parameter(Mandatory)]$Bridge,
    [Parameter(Mandatory)]$OriginalOwner,
    [Parameter(Mandatory)]$OriginalReady,
    [Parameter(Mandatory)]$Replacement,
    [Parameter(Mandatory)][hashtable]$Request,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$AdmissionSha256,
    [Parameter(Mandatory)][string]$SecurityDescriptor
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Receive {
    $read = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($Controller.StandardOutput, 4096)
    Assert ($read.Wait(90000)) 'Activation fixture controller did not reply'
    return $read.GetAwaiter().GetResult() | ConvertFrom-Json
}
function Read-Receipt([string]$File) {
    $hash = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    $retained = [Deployment.WindowsPrivateFile]::Open($File, $hash)
    try { return @{ Data=($retained.ReadText() | ConvertFrom-Json); Sha256=$hash } }
    finally { $retained.Dispose() }
}
$owner = $member = $null
try {
    $Controller.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress))
    $activated = Receive
    Assert ($activated.phase -ceq 'activated') 'Native task activation was not acknowledged'
    $runtime = $activated.runtime
    $owner = [Diagnostics.Process]::GetProcessById([int]$runtime.pid)
    $null = $owner.Handle
    Assert (-not $owner.HasExited -and $runtime.identity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($owner.Id) -and
        $runtime.identity -cne $OriginalReady.identity -and $runtime.generation -cne $OriginalReady.generation -and
        $OriginalOwner.HasExited -and $OriginalOwner.ExitCode -eq 0) 'Activation reused or lost original process authority'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    $definition = [string]$task.Xml
    Assert (-not $task.Enabled -and $task.GetInstances(0).Count -eq 1 -and
        $task.Definition.Triggers.Count -eq 0 -and $task.Definition.Settings.RestartCount -eq 0 -and
        [string]$task.GetSecurityDescriptor(7) -ceq $SecurityDescriptor) 'Activation released restart inhibition or changed task permissions'
    $binding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $owner.Id -OwnerIdentity $runtime.identity `
        -Definition $definition -SecurityDescriptor $SecurityDescriptor
    Assert ($binding.instanceGuid -ceq $runtime.instanceGuid -and $binding.sessionId -eq $runtime.sessionId) `
        'Activation lost its original native Scheduler instance'
    $ready = Read-Receipt (Join-Path $Replacement.Directory "runtime-$($runtime.identity.Replace(':', '-')).json")
    Assert ($ready.Sha256 -ceq $runtime.readySha256 -and $ready.Data.pid -eq $runtime.pid -and
        $ready.Data.identity -ceq $runtime.identity -and $ready.Data.generation -ceq $runtime.generation -and
        $ready.Data.configurationSha256 -ceq $Replacement.Sha256 -and
        $runtime.configurationSha256 -ceq $Replacement.Sha256 -and $ready.Data.launcherPid -eq $runtime.launcherPid) `
        'Activation reply differs from private original readiness'

    $published = Read-Receipt (Join-Path $Directory 'task-replace-complete.json')
    $expected = [xml]$published.Data.definition
    $namespaces = [Xml.XmlNamespaceManager]::new($expected.NameTable)
    $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $triggers = $expected.SelectNodes('/t:Task/t:Triggers', $namespaces)
    Assert ($triggers.Count -eq 1 -and $triggers[0].ChildNodes.Count -gt 0) 'Activation fixture must exercise existing automatic triggers'
    $triggers[0].IsEmpty = $true
    $restart = $expected.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $namespaces)
    Assert ($restart.Count -eq 1) 'Activation fixture must exercise restart-on-failure suppression'
    $null = $restart[0].ParentNode.RemoveChild($restart[0])
    $arguments = $expected.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces)
    $arguments.InnerText += " -ControllerPid $($Bridge.Id) -ControllerIdentity $([Deployment.WindowsWorkerJob]::ProcessIdentity($Bridge.Id))"
    Assert ($expected.OuterXml -ceq ([xml]$definition).OuterXml) 'Activation changed unrelated candidate policy or its original lease binding'
    $expectedEnabled = [xml]$expected.OuterXml
    $expectedEnabled.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText = 'true'

    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
            $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
        $writer = [int](Get-Content -LiteralPath (Join-Path $Root 'writer-pid') -Raw)
        Assert ($deadline.ElapsedMilliseconds -lt 15000 -and -not $owner.HasExited) 'Activated detached writer did not become owned'
        if ($observation.members -notcontains $writer) { Start-Sleep -Milliseconds 100 }
    } while ($observation.members -notcontains $writer)
    $member = [Diagnostics.Process]::GetProcessById($writer)
    $null = $member.Handle
    Assert (-not $member.HasExited -and $observation.members -contains $runtime.launcherPid -and
        -not $observation.quiescent -and -not $observation.applicationHealthy) 'Activation invented health or lost original Job membership'

    $transaction = Read-Receipt (Join-Path $Directory 'transaction.json')
    $stateHash = (Get-FileHash -LiteralPath (Join-Path $Control 'state.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $previous = $AdmissionSha256
    $names = @('stop-intent', 'stop-inhibited', 'stop-stop-requested', 'stop-stopped',
        'retire-requested', 'retire-complete', 'replace-requested', 'replace-complete',
        'activate-requested', 'activate-prepared', 'activate-start-requested', 'activate-running')
    foreach ($name in $names) {
        $receipt = Read-Receipt (Join-Path $Directory "task-$name.json")
        Assert ($receipt.Data.previousSha256 -ceq $previous -and $receipt.Data.operationId -ceq $OperationId -and
            $receipt.Data.admissionSha256 -ceq $AdmissionSha256 -and
            $receipt.Data.transactionSha256 -ceq $transaction.Sha256) 'Activation broke the original private transaction evidence chain'
        if ($name.StartsWith('activate-')) {
            Assert ($receipt.Data.version -eq 1 -and $receipt.Data.stateSha256 -ceq $stateHash -and
                $receipt.Data.leasePid -eq $Bridge.Id -and
                $receipt.Data.leaseIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($Bridge.Id) -and
                $receipt.Data.configurationSha256 -ceq $Replacement.Sha256 -and
                $receipt.Data.securityDescriptor -ceq $SecurityDescriptor -and
                ([xml]$receipt.Data.definition).OuterXml -ceq $expected.OuterXml -and
                ([xml]$receipt.Data.enabledDefinition).OuterXml -ceq $expectedEnabled.OuterXml) 'Activation evidence lost candidate, controller or state binding'
        }
        $previous = $receipt.Sha256
    }
    Assert (($receipt.Data.runtime | ConvertTo-Json -Compress) -ceq ($runtime | ConvertTo-Json -Compress)) `
        'Running receipt differs from the acknowledged original runtime'
    Assert (@(Get-ChildItem -LiteralPath $Directory -Filter 'task-activate-*.json').Count -eq 4) 'Repeated activation duplicated intent or completion'
    if ($Request.action.StartsWith('activate-complete')) {
        $Controller.StandardInput.WriteLine('{"action":"complete"}')
        if ($Request.action -ceq 'activate-complete-changed-state') {
            Assert ((Receive).phase -ceq 'closed') 'Changed completion state was not refused'
            Assert ($Controller.WaitForExit(15000) -and $Controller.ExitCode -eq 0 -and
                $Bridge.WaitForExit(15000) -and $owner.WaitForExit(15000) -and
                $owner.ExitCode -eq 1 -and $member.WaitForExit(15000)) 'Refused completion released its guarded runtime'
            Assert (-not $scheduler.GetFolder('\').GetTask($TaskName).Enabled -and
                -not (Test-Path -LiteralPath (Join-Path $Directory 'task-complete-policy-requested.json'))) `
                'Changed completion state altered permanent policy'
            return
        }
        Assert ((Receive).phase -ceq 'completed') 'Healthy task completion was not acknowledged'
        $terminal = Read-Receipt (Join-Path $Control 'state.json')
        Assert ($terminal.Data.phase -ceq $(if ($terminal.Data.operation -ceq 'restore') { 'restored' } else { 'accepted' })) `
            'Completion did not bind the expected terminal state'
        $permanent = [xml]$published.Data.definition
        $admitted = Read-Receipt (Join-Path $Directory 'admission.json')
        $originalTask = [xml]$admitted.Data.definition
        $originalEnabled = $originalTask.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces)
        $expectedEnabled = $null -eq $originalEnabled -or $originalEnabled.InnerText -ceq 'true'
        $task = $scheduler.GetFolder('\').GetTask($TaskName)
        $actualPermanent = [xml][string]$task.Xml
        $actualEnabledNodes = $actualPermanent.SelectNodes('/t:Task/t:Settings/t:Enabled', $namespaces)
        Assert ($actualEnabledNodes.Count -le 1 -and
            ($actualEnabledNodes.Count -eq 1 -or $expectedEnabled)) 'Permanent enabled XML is ambiguous or missing false'
        if ($actualEnabledNodes.Count) {
            Assert ($actualEnabledNodes[0].InnerText -ceq $expectedEnabled.ToString().ToLowerInvariant()) 'Permanent XML/native enabled values differ'
            $null = $actualEnabledNodes[0].ParentNode.RemoveChild($actualEnabledNodes[0])
        }
        $expectedEnabledNode = $permanent.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces)
        $null = $expectedEnabledNode.ParentNode.RemoveChild($expectedEnabledNode)
        Assert ([bool]$task.Enabled -eq $expectedEnabled -and $actualPermanent.OuterXml -ceq $permanent.OuterXml -and
            [string]$task.GetSecurityDescriptor(7) -ceq $SecurityDescriptor -and
            $task.Definition.Triggers.Count -gt 0 -and $task.Definition.Settings.RestartCount -gt 0 -and
            [string]$task.Definition.Actions.Item(1).Arguments -cnotmatch '-ControllerPid|-ControllerIdentity') `
            'Completion did not restore the exact permanent task policy'
        foreach ($phase in @('prepared', 'policy-requested', 'policy-staged', 'release-requested', 'released',
            'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete')) {
            $receipt = Read-Receipt (Join-Path $Directory "task-complete-$phase.json")
            Assert ($receipt.Data.version -eq 1 -and $receipt.Data.phase -ceq $phase -and
                $receipt.Data.previousSha256 -ceq $previous -and $receipt.Data.operationId -ceq $OperationId -and
                $receipt.Data.admissionSha256 -ceq $AdmissionSha256 -and
                $receipt.Data.transactionSha256 -ceq $transaction.Sha256 -and
                $receipt.Data.activatingStateSha256 -ceq $stateHash -and
                ($receipt.Data.runtime | ConvertTo-Json -Compress) -ceq ($runtime | ConvertTo-Json -Compress) -and
                $receipt.Data.port -gt 0 -and @($receipt.Data.providers).Count -eq 1 -and
                $receipt.Data.providers[0] -ceq 'admin-login') 'Completion receipt lost original authority or readiness'
            if ($phase -cne 'prepared') {
                Assert ($receipt.Data.stateSha256 -ceq $terminal.Sha256) 'Completion receipt terminal digest differs'
            }
            $staged = [xml]$receipt.Data.stagedDefinition
            Assert ($staged.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $namespaces).InnerText -ceq 'false' -and
                $staged.SelectNodes('/t:Task/t:Triggers/*', $namespaces).Count -eq 0 -and
                $staged.SelectNodes('/t:Task/t:Settings/t:RestartOnFailure', $namespaces).Count -eq 0 -and
                $staged.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $namespaces).InnerText -cnotmatch '-ControllerPid|-ControllerIdentity' -and
                $receipt.Data.enabled -eq $expectedEnabled -and
                $receipt.Data.securityDescriptor -ceq $SecurityDescriptor) 'Completion enabled automation before original lease release'
            $previous = $receipt.Sha256
        }
        Assert (@(Get-ChildItem -LiteralPath $Directory -Filter 'task-complete-*.json').Count -eq 9) 'Repeated completion duplicated receipts'
        if ($Request.action -ceq 'activate-complete-proof') {
            $pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
            $refused = & $pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'deployment-windows-task-completion-proof.ps1') `
                -Control $Control -ExpectedFailure 'original-processes' -ExpectedCause 'is still alive.'
            Assert ($LASTEXITCODE -eq 0 -and (($refused -join "`n") | ConvertFrom-Json).status -ceq 'refused') `
                'Fresh proof must refuse the still-live original controller'
        }
        $Controller.StandardInput.WriteLine('{"action":"close"}')
        Assert ((Receive).phase -ceq 'closed') 'Completed controller close was not acknowledged'
        Assert ($Controller.WaitForExit(15000) -and $Controller.ExitCode -eq 0 -and
            $Bridge.WaitForExit(15000) -and $Bridge.ExitCode -eq 0) 'Completed controller did not settle'
        Start-Sleep -Milliseconds 750
        Assert (-not $owner.HasExited -and -not $member.HasExited) 'Completed original runtime died with its controller'
        Assert ([Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
            $runtime.pid, $runtime.identity, 'lease', 15000) -ceq 'released') 'Independent completion observer cannot establish actual original lease release'
        if ($Request.action -ceq 'activate-complete-proof') {
            & (Join-Path $PSScriptRoot 'deployment-windows-task-completion-proof-cases.ps1') -Control $Control `
                -Root $Root -Directory $Directory -TaskName $TaskName -OperationId $OperationId -Runtime $runtime `
                -StateSha256 $terminal.Sha256 -CompletionSha256 $previous -Port $receipt.Data.port -Owner $owner -Member $member
        } elseif ($Request.action -ceq 'activate-complete-retirement') {
            $pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
            & (Get-Command node).Source (Join-Path $PSScriptRoot 'deployment-windows-task-retirement.mjs') $Control $pwsh
            Assert ($LASTEXITCODE -eq 0) 'Native checkpoint-backed receipt retirement failed'
        }
        $observation = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation,
            $runtime.pid, $runtime.identity, 'observe', 15000) | ConvertFrom-Json
        Assert ($observation.members -contains $member.Id -and $observation.members -contains $runtime.launcherPid -and
            -not $observation.quiescent -and -not $observation.applicationHealthy) 'Completion replaced runtime ownership or invented domain health'
        $task.Enabled = $false
        $null = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity, 'stop', 15000)
        Assert ($member.WaitForExit(15000)) 'Completed original member did not stop'
        $retired = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity, 'retire', 15000)
        Assert ($retired -ceq 'retired' -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) 'Completed original owner did not retire'
        Write-Output 'PASS: healthy native task completion restores permanent policy, binds terminal state and releases only the original guarded generation'
        return
    }
    if ($Request.action -ceq 'activate-readiness') {
        $Controller.StandardInput.WriteLine('{"action":"readiness"}')
        Assert ((Receive).phase -ceq 'readiness') 'Bound native HTTP readiness was not acknowledged'
        Assert (-not $owner.HasExited -and -not $member.HasExited -and
            -not $scheduler.GetFolder('\').GetTask($TaskName).Enabled) 'Readiness silently released or destroyed original activation'
        Assert ((Get-FileHash -LiteralPath (Join-Path $Control 'state.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $stateHash) `
            'Readiness silently advanced the original transaction state'
    }
    $exitWithoutClose = $Request.action -ceq 'activate-exit'
    $finalAction = if ($exitWithoutClose) { 'exit' } elseif ($Request.action -ceq 'activate-state-change') { 'changed-state' } else { 'close' }
    $Controller.StandardInput.WriteLine((@{ action=$finalAction } | ConvertTo-Json -Compress))
    if (-not $exitWithoutClose) { Assert ((Receive).phase -ceq 'closed') 'Activation context close was not acknowledged' }
    Assert ($Controller.WaitForExit(15000) -and $Controller.ExitCode -eq 0 -and $Bridge.WaitForExit(15000) -and
        $owner.WaitForExit(15000) -and $owner.ExitCode -eq 1 -and $member.WaitForExit(15000)) `
        'Unreleased activation survived original controller or bridge loss'
    $deadline.Restart()
    while ($scheduler.GetFolder('\').GetTask($TaskName).GetInstances(0).Count) {
        Assert ($deadline.ElapsedMilliseconds -lt 15000) 'Activated native task instance did not settle'
        Start-Sleep -Milliseconds 100
    }
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    Assert (-not $task.Enabled -and [string]$task.Xml -ceq $definition -and
        [string]$task.GetSecurityDescriptor(7) -ceq $SecurityDescriptor) 'Activation cleanup changed retained task inhibition or evidence'
    Write-Output 'PASS: transactional activation binds a new guarded original task/Job, preserves inhibition and settles on unreleased controller loss'
} finally {
    $Controller.Kill()
    Assert ($Controller.WaitForExit(15000) -and $Bridge.WaitForExit(15000)) 'Activation fixture controller did not settle'
    if ($owner) {
        try {
            if ($Request.action.StartsWith('activate-complete') -and -not $owner.WaitForExit(1000)) {
                $task = $scheduler.GetFolder('\').GetTask($TaskName)
                $cleanupBinding = Get-AgentsChatTaskOwnerBinding -TaskName $TaskName -OwnerPid $owner.Id -OwnerIdentity $runtime.identity `
                    -Definition ([string]$task.Xml) -SecurityDescriptor $SecurityDescriptor
                Assert ($cleanupBinding.instanceGuid -ceq $runtime.instanceGuid) 'Completion cleanup lost its original native instance'
                $task.Enabled = $false
                $null = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity, 'stop', 15000)
                $reply = [Deployment.WindowsRuntimeControl]::Exchange([guid]$runtime.generation, $runtime.pid, $runtime.identity, 'retire', 15000)
                Assert ($reply -ceq 'retired') 'Partially completed original runtime did not retire'
            }
            Assert ($owner.WaitForExit(15000)) 'Activation fixture owner survived original controller cleanup'
        }
        finally { $owner.Dispose() }
    }
    if ($member) {
        try { Assert ($member.WaitForExit(15000)) 'Activation fixture member survived original owner cleanup' }
        finally { $member.Dispose() }
    }
}
