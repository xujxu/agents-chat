param(
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][guid]$Generation,
    [Parameter(Mandatory)][string]$AccountSid,
    [Parameter(Mandatory)][int]$SessionId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$job = $null
$launcher = $null
$watch = $null
function Reply([long]$id, $value) {
    [Console]::Out.WriteLine((@{id=$id;type='reply';value=$value} | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}
function Require-Private([string]$file) {
    $acl = Get-Acl -LiteralPath $file
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $AccountSid -and $owner -ne 'S-1-5-18') { throw 'Foreign helper owner.' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -ne $AccountSid -and $rule.IdentityReference.Value -ne 'S-1-5-18') {
            throw 'Helper access is not private.'
        }
    }
}
try {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Unsupported owner platform.' }
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $AccountSid -or
        [Diagnostics.Process]::GetCurrentProcess().SessionId -ne $SessionId) { throw 'Wrong account/session.' }
    Require-Private (Split-Path $PSScriptRoot -Parent)
    Require-Private $PSScriptRoot
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) { Require-Private $file.FullName }
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs')
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwner($ControllerPid, $ControllerIdentity)
    $job = [Deployment.WindowsWorkerJob]::Create($Generation)
    $identity = @{
        kind='windows-job'; name=$job.Name; generation=$Generation.ToString('D')
        accountSid=$job.AccountSid; sessionId=$job.SessionId; ownerIdentity=$ControllerIdentity
    }
    $info = [Diagnostics.ProcessStartInfo]::new([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    foreach ($arg in @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'windows-worker-launcher.ps1'),
        '-JobName',$job.Name,'-OwnerPid',"$PID",'-OwnerIdentity',$job.OwnerIdentity)) { $info.ArgumentList.Add($arg) }
    foreach ($key in @($info.Environment.Keys)) {
        if ($key -ieq 'NODE_OPTIONS' -or $key -ieq 'NODE_PATH') { $info.Environment.Remove($key) | Out-Null }
    }
    $launcher = [Diagnostics.Process]::Start($info)
    $diagnostic = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($launcher.StandardError, 4096)
    $ready = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($launcher.StandardOutput, 131072)
    if (-not $ready.Wait(30000)) { throw 'Launcher readiness timed out.' }
    $frame = $ready.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
    if ($frame.type -cne 'ready' -or $frame.pid -ne $launcher.Id -or $frame.name -cne $job.Name -or
        $frame.processIdentity -cne [Deployment.WindowsWorkerJob]::ProcessIdentity($launcher.Id) -or
        @($job.Members()) -notcontains $launcher.Id) { throw 'Invalid launcher membership readiness.' }
    [Console]::Out.WriteLine((@{
        type='ready';identity=$identity;pid=$PID;processIdentity=$job.OwnerIdentity
    } | ConvertTo-Json -Depth 5 -Compress))
    [Console]::Out.Flush()
    $closed = $false
    $granted = $false
    $joined = $false
    $runTask = $null
    $runId = 0
    $lastId = 0
    $inputTask = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
    while ($true) {
        if ($runTask -and $runTask.IsCompleted) {
            if ($closed) { Reply $runId $null }
            else {
                $result = $runTask.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
                Reply $runId $result
            }
            $runTask = $null
        }
        if (-not $inputTask.IsCompleted) { Start-Sleep -Milliseconds 10; continue }
        $request = $inputTask.GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
        if ($request -isnot [System.Collections.IDictionary] -or -not $request.ContainsKey('id') -or
            -not $request.ContainsKey('method') -or $request.id -ne $lastId + 1) { throw 'Invalid owner request.' }
        $lastId = [long]$request.id
        if ($request.method -cne 'run' -and $request.Count -ne 2) { throw 'Unexpected owner request fields.' }
        switch -CaseSensitive ($request.method) {
            'run' {
                if ($closed -or $granted -or $request.Count -ne 3 -or -not $request.ContainsKey('command')) {
                    throw 'Command admission is closed.'
                }
                $granted = $true
                $runId = $lastId
                $launcher.StandardInput.WriteLine((@{type='run';command=$request.command} | ConvertTo-Json -Depth 8 -Compress))
                $launcher.StandardInput.Flush()
                $runTask = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync($launcher.StandardOutput, 131072)
            }
            'closeAdmission' {
                if (-not $closed) { $closed = $true; $launcher.StandardInput.Close() }
                Reply $lastId $null
            }
            'stop' {
                if (-not $closed) { throw 'Admission is still open.' }
                $job.Terminate()
                Reply $lastId $null
            }
            'join' {
                if (-not $closed) { throw 'Admission is still open.' }
                if (-not $launcher.WaitForExit(15000)) { throw 'Launcher did not exit.' }
                $until = [DateTime]::UtcNow.AddSeconds(10)
                while (@($job.Members()).Count -ne 0 -and [DateTime]::UtcNow -lt $until) {
                    Start-Sleep -Milliseconds 20
                }
                if (@($job.Members()).Count -ne 0) { throw 'Original Job is not empty.' }
                $joined = $true
                Reply $lastId $null
            }
            'observe' {
                if (-not $closed -or -not $joined) { throw 'Controllers have not joined.' }
                Reply $lastId @{identity=$identity;empty=(@($job.Members()).Count -eq 0)}
            }
            'retire' {
                if (-not $closed -or -not $joined -or @($job.Members()).Count -ne 0) { throw 'Unsafe retirement.' }
                $job.Dispose()
                $job = $null
                Reply $lastId $null
                return
            }
            default { throw 'Unknown owner method.' }
        }
        $inputTask = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 131072)
    }
} catch {
    [Console]::Error.WriteLine("Native Windows owner failed at line $($_.InvocationInfo.ScriptLineNumber) ($($_.Exception.GetType().FullName)); retain deployment evidence and inspect before recovery.")
    $global:LASTEXITCODE = 1
    exit 1
} finally {
    if ($job) { $job.Dispose() }
    if ($launcher) {
        if (-not $launcher.WaitForExit(15000)) { throw 'Native launcher did not terminate after Job closure.' }
        $launcher.Dispose()
    }
    if ($watch) { $watch.Dispose() }
}
