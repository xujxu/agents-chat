param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][string]$Node,
    [switch]$CompleteSnapshot
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/deployment'))
Add-Type -Path @((Join-Path $source 'WindowsWorkerJob.cs'), (Join-Path $source 'WindowsRuntimeDomain.cs'),
    (Join-Path $source 'WindowsRuntimePipe.cs'), (Join-Path $source 'WindowsRuntimeControl.cs'),
    (Join-Path $source 'WindowsPrivateFile.cs'), (Join-Path $source 'WindowsRuntimeLease.cs'),
    (Join-Path $source 'WindowsRuntimeHost.cs'), (Join-Path $source 'WindowsRuntimeListener.cs'))
. (Join-Path $source 'windows-task-maintenance.ps1')
. (Join-Path $source 'windows-runtime-bundle.ps1')
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-Listeners {
    @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3010)
}
function Assert-OwnedListener($Ready, $Owner, $Listener, $NativeListener) {
    $NativeListener.Check()
    Assert (-not $Owner.HasExited -and -not $Listener.HasExited) 'Original application processes exited'
    $observation = [Deployment.WindowsRuntimeControl]::Exchange(
        [guid]$Ready.generation, $Ready.pid, $Ready.identity, 'observe', 15000) | ConvertFrom-Json
    $listeners = @(Get-Listeners)
    Assert ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1' -and
        $listeners[0].OwningProcess -eq $Listener.Id -and $observation.members -contains $Listener.Id -and
        $observation.members -contains $Ready.launcherPid -and -not $observation.quiescent) `
        'Actual application listener is not in the original managed Job'
}

$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$Control = & $Node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $Control
Assert ($LASTEXITCODE -eq 0) 'Cannot canonicalize managed application parent'
$root = Join-Path $Control "managed-application-$([guid]::NewGuid())"
$environment = [ordered]@{}
foreach ($entry in Get-ChildItem Env:) {
    if ($entry.Name.ToUpperInvariant() -in @('PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
        'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA')) { $environment[$entry.Name] = $entry.Value }
}
$environment.HOME = Split-Path $Project -Parent
$environment.NODE_ENV = 'production'
$environment.NEXT_TELEMETRY_DISABLED = '1'
$environment.NEXTAUTH_SECRET = 'actions-isolated-build-fixture-secret'
$environment.NEXTAUTH_URL = 'http://localhost:3010'
$environment.ADMIN_USERNAME = 'fixture'
$environment.ADMIN_PASSWORD = 'private-fixture-password'
$runtimeEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $environment.GetEnumerator()) { $runtimeEnvironment.Add($entry.Key, $entry.Value) }
$bundle = New-AgentsChatRuntimeBundle -Source $source -Directory $root -File $Node `
    -Arguments @((Join-Path $Project 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3010') `
    -WorkingDirectory $Project -Environment $runtimeEnvironment
$configFile = $bundle.Configuration
$digest = $bundle.Sha256
$hostFile = Join-Path $root 'windows-runtime-host.ps1'
$data = Join-Path $Project '.data'
$backup = Join-Path $root 'stopped-data'
$chatId = "managed-$([guid]::NewGuid())"
$generations = [Collections.Generic.HashSet[string]]::new()
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()

$phases = if ($CompleteSnapshot) { @('create') } else { @('create', 'mutate', 'restored') }
foreach ($phase in $phases) {
    $taskName = "Agents-Chat-Application-Test-$([guid]::NewGuid())"
    $registered = $false
    $owner = $null
    $listener = $null
    $nativeListener = $null
    $context = $null
    try {
        Assert (@(Get-Listeners).Count -eq 0) 'Refusing an existing application listener'
        $action = New-ScheduledTaskAction -Execute $pwsh -WorkingDirectory $root -Argument (
            "-NoProfile -NonInteractive -File `"$hostFile`" -Configuration `"$configFile`" -Sha256 $digest")
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType S4U -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
        $registered = $true
        Start-ScheduledTask -TaskName $taskName
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            $task = $scheduler.GetFolder('\').GetTask($taskName)
            $instances = $task.GetInstances(0)
            Assert ([DateTime]::UtcNow -lt $deadline) 'Managed application task did not start'
            if ($instances.Count -ne 1) { Start-Sleep -Milliseconds 100 }
        } while ($instances.Count -ne 1)
        $owner = [Diagnostics.Process]::GetProcessById([int]$instances.Item(1).EnginePID)
        $null = $owner.Handle
        $identity = [Deployment.WindowsWorkerJob]::ProcessIdentity($owner.Id)
        $readyFile = Join-Path $root "runtime-$($identity.Replace(':', '-')).json"
        while (-not (Test-Path -LiteralPath $readyFile)) {
            Assert (-not $owner.HasExited -and [DateTime]::UtcNow -lt $deadline) 'Managed application failed before readiness'
            Start-Sleep -Milliseconds 100
        }
        $readyHash = (Get-FileHash -LiteralPath $readyFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $retained = [Deployment.WindowsPrivateFile]::Open($readyFile, $readyHash)
        try { $ready = $retained.ReadText() | ConvertFrom-Json }
        finally { $retained.Dispose() }
        Assert ($ready.version -eq 1 -and $ready.pid -eq $owner.Id -and $ready.identity -ceq $identity -and
            $ready.configurationSha256 -ceq $digest -and $ready.sessionId -eq 0 -and
            $generations.Add($ready.generation)) 'Application readiness reused an instance or lost original configuration'
        $binding = Get-AgentsChatTaskOwnerBinding -TaskName $taskName -OwnerPid $owner.Id -OwnerIdentity $identity `
            -Definition ([string]$task.Xml) -SecurityDescriptor ([string]$task.GetSecurityDescriptor(7))
        do {
            Assert (-not $owner.HasExited -and [DateTime]::UtcNow -lt $deadline) 'Managed application did not listen'
            $listeners = @(Get-Listeners)
            if (-not $listeners.Count) { Start-Sleep -Milliseconds 100 }
        } while (-not $listeners.Count)
        Assert ($listeners.Count -eq 1) 'Ambiguous application listeners'
        $listener = [Diagnostics.Process]::GetProcessById([int]$listeners[0].OwningProcess)
        $null = $listener.Handle
        $nativeListener = [Deployment.WindowsRuntimeListener]::Retain(
            [guid]$ready.generation, $ready.pid, $ready.identity, $ready.launcherPid, 3010)
        Assert-OwnedListener $ready $owner $listener $nativeListener
        & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-api.mjs') $phase $chatId
        Assert ($LASTEXITCODE -eq 0) "Managed application API $phase failed"
        Assert-OwnedListener $ready $owner $listener $nativeListener

        if ($CompleteSnapshot) {
            $git = (Get-Command git.exe).Source
            $snapshotControl = Join-Path $root 'snapshot-control'
            [Deployment.WindowsPrivateFile]::CreateDirectory($snapshotControl).Dispose()
            $originalPath = $env:PATH
            try {
                $env:PATH = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'
                & $Node (Join-Path $PSScriptRoot 'deployment-windows-application-snapshot.mjs') `
                    $Project $taskName $pwsh $git $snapshotControl
                Assert ($LASTEXITCODE -eq 0) 'Complete actual application snapshot failed'
            } finally { $env:PATH = $originalPath }
            $stopped = [Deployment.WindowsRuntimeControl]::Exchange(
                [guid]$ready.generation, $ready.pid, $ready.identity, 'observe', 15000) | ConvertFrom-Json
            Assert ($stopped.quiescent -and @($stopped.members).Count -eq 0 -and -not $owner.HasExited -and
                $listener.WaitForExit(15000) -and @(Get-Listeners).Count -eq 0 -and
                -not $scheduler.GetFolder('\').GetTask($taskName).Enabled) `
                'Snapshot lost original stopped runtime or restart inhibition'
            $retired = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
                $ready.pid, $ready.identity, 'retire', 15000)
            Assert ($retired -ceq 'retired' -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) `
                'Snapshot fixture original owner did not retire'
            Write-Output 'PASS: complete application snapshot retains quiescence and original-owner cleanup'
            continue
        }

        if ($phase -eq 'create') {
            $git = (Get-Command git.exe).Source
            $preflight = Join-Path $root 'preflight'
            [Deployment.WindowsPrivateFile]::CreateDirectory($preflight).Dispose()
            $originalPath = $env:PATH
            try {
                $env:PATH = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0'
                & $Node (Join-Path $PSScriptRoot 'deployment-windows-target-preflight.mjs') $Project $taskName $pwsh $git $preflight
                Assert ($LASTEXITCODE -eq 0) 'Original managed application target preflight failed'
            } finally { $env:PATH = $originalPath }
            Assert-OwnedListener $ready $owner $listener $nativeListener
        }

        $directory = Join-Path $root $phase
        [Deployment.WindowsPrivateFile]::CreateDirectory($directory).Dispose()
        $record = [ordered]@{
            version=1; operationId=[guid]::NewGuid().ToString('D')
            controllerPid=$PID; controllerIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
            taskName=$taskName; definition=[string]$task.Xml; securityDescriptor=[string]$task.GetSecurityDescriptor(7)
            configuration=$configFile; configurationSha256=$digest; readySha256=$readyHash
            ownerPid=$owner.Id; ownerIdentity=$identity; generation=$ready.generation; instanceGuid=$binding.instanceGuid
        }
        $admission = Join-Path $directory 'admission.json'
        $published = [Deployment.WindowsPrivateFile]::Publish($admission, ($record | ConvertTo-Json -Depth 8 -Compress))
        try { $admissionHash = $published.Sha256 }
        finally { $published.Dispose() }
        $context = Stop-AgentsChatManagedTask -Admission $admission -Sha256 $admissionHash
        Assert ($listener.WaitForExit(15000) -and @(Get-Listeners).Count -eq 0) 'Application listener survived original-domain stop'
        $null = Assert-AgentsChatTaskStopped -Context $context
        if ($phase -eq 'create') {
            Assert (Test-Path -LiteralPath (Join-Path $data 'chats.db')) 'Real application database was not created'
            Copy-Item -LiteralPath $data -Destination $backup -Recurse
        } elseif ($phase -eq 'mutate') {
            Assert (Test-Path -LiteralPath (Join-Path $backup 'chats.db')) 'Stopped database backup is missing'
            Remove-Item -LiteralPath $data -Recurse -Force
            Copy-Item -LiteralPath $backup -Destination $data -Recurse
        }
        $null = Assert-AgentsChatTaskStopped -Context $context
        Close-AgentsChatTaskMaintenance -Context $context
        $context = $null
        $retired = [Deployment.WindowsRuntimeControl]::Exchange([guid]$ready.generation,
            $ready.pid, $ready.identity, 'retire', 15000)
        Assert ($retired -ceq 'retired' -and $owner.WaitForExit(15000) -and $owner.ExitCode -eq 0) `
            'Managed application original owner did not retire'
        Assert (-not $scheduler.GetFolder('\').GetTask($taskName).Enabled) 'Application maintenance lost restart inhibition'
        Write-Output "PASS: real Windows application $phase binds listener ownership and settles before data access"
    } finally {
        if ($nativeListener) { $nativeListener.Dispose() }
        if ($context) { Close-AgentsChatTaskMaintenance -Context $context }
        if ($registered) { Stop-ScheduledTask -TaskName $taskName }
        if ($owner) {
            Assert ($owner.WaitForExit(15000)) 'Generated application owner did not exit during cleanup'
            $owner.Dispose()
        }
        if ($listener) {
            Assert ($listener.WaitForExit(15000)) 'Generated application listener survived cleanup'
            $listener.Dispose()
        }
        if ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    }
}
if (-not $CompleteSnapshot) {
    Write-Output 'PASS: three prebuilt Windows application starts preserve authenticated data and restore the stopped database'
}
