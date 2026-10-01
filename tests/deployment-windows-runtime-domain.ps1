param(
    [switch]$Server,
    [string]$HelperRoot,
    [string]$Node,
    [guid]$Generation
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = if ($Server) { $HelperRoot } else { Join-Path $PSScriptRoot '../scripts/deployment' }
Add-Type -Path @((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'))
Add-Type -Path (Join-Path $source 'WindowsRuntimePipe.cs')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Await($Task) {
    Assert ($Task.Wait(15000)) 'Native runtime operation timed out'
    return $Task.GetAwaiter().GetResult()
}
if ($Server) {
    $domain = $null
    $pipe = $null
    try {
        $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
        $environment.Add('SystemRoot', $env:SystemRoot)
        $environment.Add('PATH', $env:PATH)
        $pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $domain = [Deployment.WindowsRuntimeDomain]::Start($Generation, $pwsh, $HelperRoot,
            $Node, [string[]]@((Join-Path $HelperRoot 'writer.cjs')), $HelperRoot, $environment)
        $pipe = [Deployment.WindowsRuntimePipe]::Create($Generation)
        @{
            pid=$PID
            identity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            job=$domain.Name
            launcherPid=$domain.LauncherPid
            sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $HelperRoot 'ready.json')
        $finished = $false
        while (-not $finished) {
            Await ($pipe.WaitForConnectionAsync())
            $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
            $writer = $null
            try {
                $command = Await ($reader.ReadLineAsync())
                if ($null -eq $command) { continue }
                $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
                $writer.AutoFlush = $true
                switch -CaseSensitive ($command) {
                    'observe' { $writer.WriteLine(($domain.Observe() | ConvertTo-Json -Compress)) }
                    'stop' {
                        $domain.Stop()
                        $writer.WriteLine(($domain.Observe() | ConvertTo-Json -Compress))
                    }
                    'retire' {
                        $domain.Retire()
                        $writer.WriteLine('retired')
                        $finished = $true
                    }
                    default { throw 'Unexpected fixture control request' }
                }
            } finally {
                $reader.Dispose()
                if ($writer) { $writer.Dispose() }
                $pipe.Disconnect()
            }
        }
    } catch {
        $failure = $_.Exception.GetBaseException()
        "$($failure.GetType().FullName) at line $($_.InvocationInfo.ScriptLineNumber): $($failure.Message)" |
            Set-Content -LiteralPath (Join-Path $HelperRoot 'failure.txt')
        throw
    } finally {
        if ($pipe) { $pipe.Dispose() }
        if ($domain) { $domain.Dispose() }
    }
    return
}

function Request($Identity, [guid]$Generation, [string]$Method) {
    $client = [Deployment.WindowsRuntimePipe]::Connect($Generation, $Identity.pid, $Identity.identity, 5000)
    $reader = $null
    $writer = $null
    try {
        $reader = [IO.StreamReader]::new($client, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
        $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false), 4096, $true)
        $writer.AutoFlush = $true
        $writer.WriteLine($Method)
        return Await ($reader.ReadLineAsync())
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($writer) { $writer.Dispose() }
        $client.Dispose()
    }
}

$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$node = (Get-Command node).Source
foreach ($mode in @('stop', 'owner-death')) {
    $generation = [guid]::NewGuid()
    $root = Join-Path ([IO.Path]::GetTempPath()) "agents-runtime-domain-$generation space"
    $taskName = "Agents-Chat-Runtime-Domain-Test-$generation"
    $registered = $false
    $owner = $null
    $member = $null
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = Get-Acl -LiteralPath $root
        $acl.SetAccessRuleProtection($true, $false)
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
            'ContainerInherit, ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $root -AclObject $acl
        foreach ($name in @('WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs', 'windows-worker-launcher.ps1')) {
            Copy-Item -LiteralPath (Join-Path $source $name) -Destination $root
        }
        @'
const fs = require('node:fs');
if (process.argv[2] === 'child') {
  fs.writeFileSync('writer-pid', String(process.pid));
  fs.writeFileSync('writes', 'x');
  setInterval(() => fs.appendFileSync('writes', 'x'), 10);
} else {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [__filename, 'child'], { detached: true, stdio: 'ignore' });
  child.unref();
  const wait = setInterval(() => {
    if (fs.existsSync('writes')) { clearInterval(wait); process.exit(0); }
  }, 10);
}
'@ | Set-Content -LiteralPath (Join-Path $root 'writer.cjs')
        $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $root -Argument (
            "-NoProfile -NonInteractive -File `"$PSCommandPath`" -Server -Generation $generation -HelperRoot `"$root`" -Node `"$node`"")
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
        $registered = $true
        Start-ScheduledTask -TaskName $taskName
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        while (-not (Test-Path -LiteralPath (Join-Path $root 'ready.json')) -or
            -not (Test-Path -LiteralPath (Join-Path $root 'writes'))) {
            if (Test-Path -LiteralPath (Join-Path $root 'failure.txt')) {
                throw (Get-Content -LiteralPath (Join-Path $root 'failure.txt') -Raw)
            }
            Assert ([DateTime]::UtcNow -lt $deadline) 'Task-side runtime owner failed to admit the detached writer'
            Start-Sleep -Milliseconds 100
        }
        $identity = Get-Content -LiteralPath (Join-Path $root 'ready.json') -Raw | ConvertFrom-Json
        $owner = [Diagnostics.Process]::GetProcessById($identity.pid)
        $null = $owner.Handle
        Assert ([Deployment.WindowsWorkerJob]::ProcessIdentity($owner.Id) -ceq $identity.identity) 'Original task owner changed'
        Assert ($identity.sessionId -eq 0) 'Expected actual S4U session-zero runtime'
        $member = [Diagnostics.Process]::GetProcessById([int](Get-Content -LiteralPath (Join-Path $root 'writer-pid') -Raw))
        $null = $member.Handle
        do {
            $observation = Request $identity $generation 'observe' | ConvertFrom-Json
            Assert ([DateTime]::UtcNow -lt $deadline) 'Original command root did not exit'
        } while ($observation.phase -ne 'root-exited')
        Assert ($observation.rootExitCode -eq 0 -and $observation.members -contains $member.Id) 'Detached writer escaped the retained Job'
        Assert ($observation.members -contains $identity.launcherPid) 'Original launcher is no longer retained'
        Assert (-not $observation.applicationHealthy -and -not $observation.quiescent) 'Job observation invented application health or quiescence'
        $length = (Get-Item -LiteralPath (Join-Path $root 'writes')).Length
        Start-Sleep -Milliseconds 300
        Assert ((Get-Item -LiteralPath (Join-Path $root 'writes')).Length -gt $length) 'A disconnected observer stopped the running service'
        Write-Output "PASS: $mode actual task retains detached writers after command-root exit and observer disconnect"

        if ($mode -eq 'stop') {
            $observation = Request $identity $generation 'stop' | ConvertFrom-Json
            Assert ($observation.phase -eq 'stopped' -and $observation.quiescent -and $observation.members.Count -eq 0) 'Stop did not settle the original Job'
            Assert (-not $owner.HasExited) 'Owner exited before final settlement could be observed'
            $again = Request $identity $generation 'observe' | ConvertFrom-Json
            Assert ($again.phase -eq 'stopped' -and $again.members.Count -eq 0) 'Original empty Job evidence was lost'
            Assert ((Request $identity $generation 'retire') -ceq 'retired') 'Original Job could not retire after settlement'
        } else {
            $owner.Kill()
        }
        Assert ($owner.WaitForExit(15000)) 'Task-side original owner did not exit'
        Assert ($member.WaitForExit(15000)) 'Detached writer survived original Job settlement or owner death'
        $length = (Get-Item -LiteralPath (Join-Path $root 'writes')).Length
        Start-Sleep -Milliseconds 300
        Assert ((Get-Item -LiteralPath (Join-Path $root 'writes')).Length -eq $length) 'Detached writer changed files after settlement'
        Write-Output "PASS: $mode settles the original task-side Job without port or descendant-PID killing"
    } catch {
        if (Test-Path -LiteralPath (Join-Path $root 'failure.txt')) {
            Write-Warning (Get-Content -LiteralPath (Join-Path $root 'failure.txt') -Raw)
        }
        throw
    } finally {
        if ($registered) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        }
        if ($owner) {
            Assert ($owner.WaitForExit(15000)) 'Fixture task owner remains alive'
            $owner.Dispose()
        }
        if ($member) {
            Assert ($member.WaitForExit(15000)) 'Fixture detached writer remains alive'
            $member.Dispose()
        }
        if ($owner -or -not $registered) { Remove-Item -LiteralPath $root -Recurse -Force }
        else { Write-Warning "Preserving fixture without process-exit evidence: $root" }
    }
}
