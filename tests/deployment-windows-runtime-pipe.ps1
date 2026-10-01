param(
    [switch]$Server,
    [guid]$Generation,
    [string]$ReadyFile
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/deployment/WindowsRuntimePipe.cs')

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

if ($Server) {
    $pipe = $null
    try {
        $pipe = [Deployment.WindowsRuntimePipe]::Create($Generation)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl = [Security.AccessControl.RawSecurityDescriptor]::new(
            [Deployment.WindowsRuntimePipe]::SecurityDescriptor($pipe), 0)
        Assert (($acl.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) 'Runtime pipe DACL is not protected'
        Assert ($acl.DiscretionaryAcl.Count -eq 2) 'Unexpected runtime pipe ACE count'
        foreach ($ace in $acl.DiscretionaryAcl) {
            Assert ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) 'Unexpected runtime pipe ACE'
            Assert ($ace.SecurityIdentifier.Value -in @($sid, 'S-1-5-18')) 'Runtime pipe grants foreign access'
        }
        $current = [Diagnostics.Process]::GetCurrentProcess()
        @{
            pid=$PID
            identity="$PID`:$($current.StartTime.ToUniversalTime().Ticks)"
            sid=$sid
            sessionId=$current.SessionId
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyFile
        $finished = $false
        while (-not $finished) {
            $waiting = $pipe.WaitForConnectionAsync()
            Assert ($waiting.Wait(20000)) 'Runtime fixture connection timed out'
            $waiting.GetAwaiter().GetResult()
            $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
            $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 4096, $true)
            $writer.AutoFlush = $true
            try {
                $line = $reader.ReadLineAsync()
                Assert ($line.Wait(5000)) 'Runtime fixture command timed out'
                $command = $line.GetAwaiter().GetResult()
                if ($null -ne $command) {
                    Assert ($command -ceq 'hello') 'Unexpected runtime fixture handshake'
                    $pipe.RunAsClient([IO.Pipes.PipeStreamImpersonationWorker]{
                        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
                        try {
                            Assert ($identity.ImpersonationLevel -eq [Security.Principal.TokenImpersonationLevel]::Identification) 'Client allowed more than identification'
                        } finally { $identity.Dispose() }
                    })
                    $writer.WriteLine('original-server')
                    $line = $reader.ReadLineAsync()
                    Assert ($line.Wait(5000)) 'Runtime fixture finish timed out'
                    Assert ($line.GetAwaiter().GetResult() -ceq 'finish') 'Unexpected runtime fixture command'
                    $writer.WriteLine('finished')
                    $finished = $true
                }
            } finally {
                $reader.Dispose()
                $writer.Dispose()
                $pipe.Disconnect()
            }
        }
    } catch {
        $failure = $_.Exception.GetBaseException()
        "$($failure.GetType().FullName) at line $($_.InvocationInfo.ScriptLineNumber): $($failure.Message)" |
            Set-Content -LiteralPath ($ReadyFile + '.failure')
        throw
    } finally {
        if ($pipe) { $pipe.Dispose() }
    }
    return
}

$taskName = "Agents-Chat-Runtime-Pipe-Test-$([guid]::NewGuid())"
$generation = [guid]::NewGuid()
$root = Join-Path ([IO.Path]::GetTempPath()) "agents-runtime-pipe-$generation space"
$ready = Join-Path $root 'ready.json'
$registered = $false
$owner = $null
$client = $null
$current = [Diagnostics.Process]::GetCurrentProcess()
$ownIdentity = "$PID`:$($current.StartTime.ToUniversalTime().Ticks)"
foreach ($timeout in @(0, 30001)) {
    $invalid = $false
    try {
        $unexpected = [Deployment.WindowsRuntimePipe]::Connect([guid]::NewGuid(), $PID, $ownIdentity, $timeout)
        $unexpected.Dispose()
    } catch {
        $errorValue = $_.Exception.GetBaseException()
        $invalid = $errorValue -is [ArgumentOutOfRangeException] -and $errorValue.ParamName -eq 'timeoutMilliseconds'
    }
    Assert $invalid 'Unsupported connection timeout was accepted'
}
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $root -Argument (
        "-NoProfile -NonInteractive -File `"$PSCommandPath`" -Server -Generation $generation -ReadyFile `"$ready`"")
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $ready)) {
        if (Test-Path -LiteralPath ($ready + '.failure')) {
            throw (Get-Content -LiteralPath ($ready + '.failure') -Raw)
        }
        Assert ([DateTime]::UtcNow -lt $deadline) 'Actual Scheduled Task pipe owner did not start'
        Start-Sleep -Milliseconds 100
    }
    $observed = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
    $owner = [Diagnostics.Process]::GetProcessById($observed.pid)
    $null = $owner.Handle
    Assert ("$($owner.Id):$($owner.StartTime.ToUniversalTime().Ticks)" -ceq $observed.identity) 'Fixture owner identity changed'
    Assert ($observed.sid -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Wrong task account'
    Assert ($observed.sessionId -eq 0) 'S4U runtime fixture must run in session zero'

    $collision = $false
    try { $unexpected = [Deployment.WindowsRuntimePipe]::Create($generation); $unexpected.Dispose() }
    catch { $collision = $_.Exception.GetBaseException() -is [ComponentModel.Win32Exception] }
    Assert $collision 'A second server must not adopt an existing runtime pipe'
    Write-Output 'PASS: actual S4U task owns a private, exclusive runtime pipe'

    $changed = $false
    try {
        $unexpected = [Deployment.WindowsRuntimePipe]::Connect($generation, $observed.pid, "$($observed.pid):1", 1000)
        $unexpected.Dispose()
    } catch { $changed = $_.Exception.GetBaseException().Message -eq 'Runtime pipe owner identity changed.' }
    Assert $changed 'Changed owner start-time was accepted'

    $foreign = $false
    try {
        $unexpected = [Deployment.WindowsRuntimePipe]::Connect($generation, $PID, $ownIdentity, 1000)
        $unexpected.Dispose()
    } catch { $foreign = $_.Exception.GetBaseException().Message -eq 'Runtime pipe server identity differs.' }
    Assert $foreign 'A live but unrelated process was accepted as the pipe owner'
    Write-Output 'PASS: runtime connection rejects stale owner identity and a different live server'

    $client = [Deployment.WindowsRuntimePipe]::Connect($generation, $observed.pid, $observed.identity, 5000)
    $reader = [IO.StreamReader]::new($client, [Text.UTF8Encoding]::new($false), $false, 4096, $true)
    $writer = [IO.StreamWriter]::new($client, [Text.UTF8Encoding]::new($false), 4096, $true)
    $writer.AutoFlush = $true
    $writer.WriteLine('hello')
    foreach ($expected in @('original-server', 'finished')) {
        $read = $reader.ReadLineAsync()
        Assert ($read.Wait(5000)) 'Actual task reply timed out'
        Assert ($read.GetAwaiter().GetResult() -ceq $expected) 'Unexpected actual task reply'
        if ($expected -eq 'original-server') { $writer.WriteLine('finish') }
    }
    $reader.Dispose()
    $writer.Dispose()
    $client.Dispose()
    $client = $null
    Assert ($owner.WaitForExit(15000)) 'Original task owner did not exit'
    Write-Output 'PASS: identity-bound connection communicates with the original scheduled owner'

    $missing = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $unexpected = [Deployment.WindowsRuntimePipe]::Connect([guid]::NewGuid(), $PID, $ownIdentity, 100)
        $unexpected.Dispose()
    } catch { $missing = $_.Exception.GetBaseException() -is [TimeoutException] }
    Assert ($missing -and $timer.Elapsed.TotalSeconds -lt 5) 'Missing runtime pipe did not fail within its bound'
    Write-Output 'PASS: missing runtime connection fails with a bounded timeout'
} finally {
    if ($client) { $client.Dispose() }
    if ($registered) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }
    if ($owner) {
        Assert ($owner.WaitForExit(15000)) 'Original task owner remains alive during cleanup'
        $owner.Dispose()
        Remove-Item -LiteralPath $root -Recurse -Force
    } elseif (-not $registered) {
        Remove-Item -LiteralPath $root -Recurse -Force
    } else {
        Write-Warning "Preserving fixture directory without process-exit evidence: $root"
    }
}
