$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path (Join-Path $source 'WindowsWorkerJob.cs')
$node = (Get-Command node).Source
$pwsh = (Get-Command pwsh).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ("agents-job-" + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($root) | Out-Null
$acl = Get-Acl $root
$acl.SetAccessRuleProtection($true, $false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
    'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl $root $acl
Copy-Item (Join-Path $source 'WindowsWorkerJob.cs') $root
Copy-Item (Join-Path $source 'windows-worker-launcher.ps1') $root
$script:passed = 0

function Assert($condition, $message) {
    if (-not $condition) { throw $message }
}
function Expect-Failure([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert $failed 'Expected explicit native failure.'
}
function Await-Task($task) {
    Assert ($task.Wait(30000)) 'Native task timed out.'
    return $task.GetAwaiter().GetResult()
}
function Start-Launcher($job) {
    $info = [Diagnostics.ProcessStartInfo]::new($pwsh)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File',
        (Join-Path $root 'windows-worker-launcher.ps1'), '-JobName', $job.Name,
        '-OwnerPid', "$PID", '-OwnerIdentity', [Deployment.WindowsWorkerJob]::ProcessIdentity($PID))) {
        $info.ArgumentList.Add($arg)
    }
    foreach ($key in @($info.Environment.Keys)) {
        if ($key -ieq 'NODE_OPTIONS' -or $key -ieq 'NODE_PATH') { $info.Environment.Remove($key) | Out-Null }
    }
    $process = [Diagnostics.Process]::Start($info)
    $diagnostics = $process.StandardError.ReadToEndAsync()
    $ready = Await-Task ($process.StandardOutput.ReadLineAsync())
    if (-not $ready) {
        $process.WaitForExit(10000) | Out-Null
        throw ("Launcher failed before readiness: " + (Await-Task $diagnostics))
    }
    $frame = $ready | ConvertFrom-Json
    Assert ($frame.type -eq 'ready' -and $frame.pid -eq $process.Id) 'Invalid native readiness.'
    Assert ($frame.name -eq $job.Name) 'Wrong Job in readiness.'
    Assert (@($job.Members()) -contains $process.Id) 'Launcher not contained before grant.'
    return @{ Process = $process; Diagnostics = $diagnostics }
}
function Send-Target($launcher, [string]$code, [string[]]$extraArgs = @()) {
    $command = @{
        file = $node; args = @('-e', $code) + $extraArgs; cwd = $root
        env = @{ PATH = $env:PATH; SystemRoot = $env:SystemRoot; NATIVE_VALUE = 'literal %n $HOME " space' }
    }
    $launcher.Process.StandardInput.WriteLine((@{type='run';command=$command} | ConvertTo-Json -Depth 8 -Compress))
    $launcher.Process.StandardInput.Flush()
}
function Settle($job, $launcher) {
    $launcher.Process.StandardInput.Close()
    $job.Terminate()
    Assert ($launcher.Process.WaitForExit(15000)) 'Launcher did not exit.'
    $until = [DateTime]::UtcNow.AddSeconds(15)
    while (@($job.Members()).Count -ne 0 -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 25 }
    Assert (@($job.Members()).Count -eq 0) 'Original retained Job is not empty.'
    $launcher.Process.Dispose()
}
function Case([string]$name, [scriptblock]$Body) {
    & $Body
    $script:passed++
    Write-Output "PASS $name"
}
try {
    Case 'explicit flags, original identity, ACL and same-name collision' {
        $generation = [guid]::NewGuid()
        $job = [Deployment.WindowsWorkerJob]::Create($generation)
        try {
            Assert ($job.KillOnClose -and -not $job.Inheritable) 'Unsafe native Job configuration.'
            Assert ($job.AccountSid -eq $sid.Value) 'Account identity changed.'
            Assert ($job.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId) 'Session changed.'
            $security = [Security.AccessControl.RawSecurityDescriptor]::new($job.SecurityDescriptor, 0)
            Assert (($security.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) 'Job DACL is not protected.'
            Assert ($security.DiscretionaryAcl.Count -eq 2) 'Job DACL has unexpected entries.'
            foreach ($ace in $security.DiscretionaryAcl) {
                Assert (@($sid.Value, 'S-1-5-18') -contains $ace.SecurityIdentifier.Value) 'Job grants another account access.'
                Assert ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) 'Unexpected Job ACE type.'
            }
            Assert (@($job.Members()).Count -eq 0) 'New Job is not empty.'
            Expect-Failure { [Deployment.WindowsWorkerJob]::Create($generation) }
            Assert (@($job.Members()).Count -eq 0) 'Collision modified the original Job.'
        } finally { $job.Dispose() }
        Expect-Failure { $job.Members() }
    }
    Case 'no target before grant and exact argv/environment transport' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            $marker = Join-Path $root 'literal.json'
            Assert (-not (Test-Path $marker)) 'Target ran before grant.'
            Send-Target $launcher 'require("node:fs").writeFileSync("literal.json",JSON.stringify([process.env.NATIVE_VALUE,...process.argv.slice(1)]));' @('%n', '$HOME', 'quote " space', 'semi;colon')
            $result = (Await-Task ($launcher.Process.StandardOutput.ReadLineAsync())) | ConvertFrom-Json
            Assert ($result.type -eq 'result' -and $result.exitCode -eq 0) 'Target failed.'
            $values = Get-Content $marker -Raw | ConvertFrom-Json
            Assert ($values[0] -eq 'literal %n $HOME " space') 'Environment reinterpreted.'
            Assert ($values[1] -eq '%n' -and $values[2] -eq '$HOME' -and $values[3] -eq 'quote " space') 'Argument reinterpreted.'
            Settle $job $launcher
            $launcher = $null
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Case 'cancellation before grant closes launcher without executing a target' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        try {
            $launcher = Start-Launcher $job
            Settle $job $launcher
        } finally { $job.Dispose() }
    }
    Case 'detached writer survives root exit but cannot survive Job termination' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            $writer = Join-Path $root 'writer'
            $code = @'
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const c=spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('writer','x');setInterval(()=>fs.appendFileSync('writer','x'),10)"],{detached:true,stdio:'ignore'});
c.unref();const t=setInterval(()=>{if(fs.existsSync('writer')){clearInterval(t);process.exit(0)}},10);
'@
            Send-Target $launcher $code
            $result = (Await-Task ($launcher.Process.StandardOutput.ReadLineAsync())) | ConvertFrom-Json
            Assert ($result.exitCode -eq 0) 'Root failed.'
            Assert (@($job.Members()).Count -ge 2) 'Independent descendant was not retained in the Job.'
            Settle $job $launcher
            $launcher = $null
            $length = (Get-Item $writer).Length
            Start-Sleep -Milliseconds 300
            Assert ((Get-Item $writer).Length -eq $length) 'Writer survived confirmed settlement.'
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Case 'last owner handle close kills launcher and target without taskkill' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            Send-Target $launcher 'setInterval(()=>{},1000);'
            $job.Dispose()
            Assert ($launcher.Process.WaitForExit(15000)) 'Kill-on-close did not terminate launcher.'
            $launcher.Process.Dispose()
            $launcher = $null
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Case 'abrupt native owner death kills the original Job without finally or taskkill' {
        $info = [Diagnostics.ProcessStartInfo]::new($pwsh)
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        foreach ($arg in @('-NoProfile', '-NonInteractive', '-File',
            (Join-Path $PSScriptRoot 'deployment-windows-job-owner.ps1'), '-HelperRoot', $root, '-Node', $node)) {
            $info.ArgumentList.Add($arg)
        }
        $owner = [Diagnostics.Process]::Start($info)
        $diagnostics = $owner.StandardError.ReadToEndAsync()
        $members = @()
        try {
            $line = Await-Task ($owner.StandardOutput.ReadLineAsync())
            if (-not $line) { throw ("Owner failed: " + (Await-Task $diagnostics)) }
            $frame = $line | ConvertFrom-Json
            $members = @($frame.members)
            Assert ($frame.type -eq 'ready' -and $members.Count -ge 2) 'Owner did not start contained writers.'
            $owner.Kill()
            Assert ($owner.WaitForExit(15000)) 'Owner did not terminate.'
            foreach ($member in $members) {
                $process = $null
                try { $process = [Diagnostics.Process]::GetProcessById([int]$member.pid) }
                catch [ArgumentException] { continue }
                try {
                    if ([Deployment.WindowsWorkerJob]::ProcessIdentity($process.Id) -eq $member.identity) {
                        Assert ($process.WaitForExit(15000)) 'Original Job member survived owner death.'
                    }
                } finally { $process.Dispose() }
            }
            $marker = Join-Path $root 'owner-writer'
            $length = (Get-Item $marker).Length
            Start-Sleep -Milliseconds 300
            Assert ((Get-Item $marker).Length -eq $length) 'Writer survived original owner death.'
        } finally {
            if (-not $owner.HasExited) { $owner.Kill(); $owner.WaitForExit(15000) | Out-Null }
            $owner.Dispose()
        }
    }
    Case 'large independent stdout and stderr stay bounded while native members settle' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            Send-Target $launcher 'process.stdout.write("o".repeat(2*1024*1024));process.stderr.write("e".repeat(2*1024*1024),()=>process.exit(7));'
            $result = (Await-Task ($launcher.Process.StandardOutput.ReadLineAsync())) | ConvertFrom-Json
            Assert ($result.exitCode -eq 7) 'Nonzero command status lost.'
            Assert ([Convert]::FromBase64String($result.stdout).Length -eq 8192) 'stdout tail is not bounded.'
            Assert ([Convert]::FromBase64String($result.stderr).Length -eq 8192) 'stderr tail is not bounded.'
            Settle $job $launcher
            $launcher = $null
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Case 'malformed grant never starts an uncontained target' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            $launcher.Process.StandardInput.WriteLine('{"type":"run","command":{"file":"cmd.exe"}}')
            $launcher.Process.StandardInput.Flush()
            Assert ($launcher.Process.WaitForExit(15000)) 'Malformed grant left a launcher running.'
            Assert ($launcher.Process.ExitCode -ne 0) 'Malformed grant was accepted.'
            Assert (@($job.Members()).Count -eq 0) 'Malformed grant left a Job writer.'
            $launcher.Process.Dispose()
            $launcher = $null
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Case 'launcher death does not erase original descendant ownership or affect an unrelated sentinel' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        $sentinelInfo = [Diagnostics.ProcessStartInfo]::new($node)
        $sentinelInfo.UseShellExecute = $false
        $sentinelInfo.ArgumentList.Add('-e')
        $sentinelInfo.ArgumentList.Add('setInterval(()=>{},1000);')
        $sentinel = [Diagnostics.Process]::Start($sentinelInfo)
        try {
            $launcher = Start-Launcher $job
            Send-Target $launcher 'const fs=require("node:fs");fs.writeFileSync("launcher-writer","x");setInterval(()=>fs.appendFileSync("launcher-writer","x"),10);'
            $marker = Join-Path $root 'launcher-writer'
            $until = [DateTime]::UtcNow.AddSeconds(15)
            while (-not (Test-Path $marker) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 25 }
            Assert (Test-Path $marker) 'Target failed to start.'
            $launcher.Process.Kill()
            Assert ($launcher.Process.WaitForExit(15000)) 'Launcher did not exit.'
            Assert (@($job.Members()).Count -ge 1) 'Launcher exit was incorrectly treated as descendant extinction.'
            Assert (@($job.Members()) -notcontains $sentinel.Id) 'Unrelated sentinel was assigned to Job.'
            $job.Terminate()
            $until = [DateTime]::UtcNow.AddSeconds(15)
            while (@($job.Members()).Count -ne 0 -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 25 }
            Assert (@($job.Members()).Count -eq 0) 'Descendant survived explicit termination.'
            Assert (-not $sentinel.HasExited) 'Unrelated sentinel was terminated.'
            $length = (Get-Item $marker).Length
            Start-Sleep -Milliseconds 300
            Assert ((Get-Item $marker).Length -eq $length) 'Target still writes after empty Job.'
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
            if (-not $sentinel.HasExited) { $sentinel.Kill(); $sentinel.WaitForExit(10000) | Out-Null }
            $sentinel.Dispose()
        }
    }
    Case 'oversized command frames fail before target execution' {
        $job = [Deployment.WindowsWorkerJob]::Create([guid]::NewGuid())
        $launcher = $null
        try {
            $launcher = Start-Launcher $job
            $launcher.Process.StandardInput.WriteLine(('x' * 65537))
            $launcher.Process.StandardInput.Flush()
            Assert ($launcher.Process.WaitForExit(15000)) 'Oversized input did not terminate the launcher boundedly.'
            Assert ($launcher.Process.ExitCode -ne 0) 'Oversized input was accepted.'
            Assert (@($job.Members()).Count -eq 0) 'Oversized input created a surviving Job member.'
        } finally {
            $job.Dispose()
            if ($launcher) { $launcher.Process.WaitForExit(10000) | Out-Null; $launcher.Process.Dispose() }
        }
    }
    Write-Output ("WINDOWS_JOB_TESTS_PASSED=" + $script:passed)
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
