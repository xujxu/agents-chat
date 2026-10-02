param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)]$Ready,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)][ValidateSet('listener-v4', 'listener-v6')][string]$Scenario
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Refuses([scriptblock]$Action, [string]$Message) {
    $refused = $false
    try { & $Action }
    catch { $refused = $_.Exception.GetBaseException().Message -ceq $Message }
    Assert $refused "Expected native listener refusal: $Message"
}
function Retain([int]$Port) {
    [Deployment.WindowsRuntimeListener]::Retain([guid]$Ready.generation, $Ready.pid,
        $Ready.identity, $Ready.launcherPid, $Port)
}
function Wait-File([string]$File) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $File)) {
        Assert (-not $Owner.HasExited -and $deadline.ElapsedMilliseconds -lt 15000) 'Original owned listener did not become ready'
        Start-Sleep -Milliseconds 100
    }
    return Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
}
$retained = $fresh = $foreign = $duplicate = $listener = $null
try {
    $endpoint = Wait-File (Join-Path $Root 'listener.json')
    $listener = [Diagnostics.Process]::GetProcessById([int]$endpoint.pid)
    $null = $listener.Handle
    $retained = Retain $endpoint.port
    Assert ($retained.ListenerPid -eq $listener.Id -and
        $retained.ListenerIdentity -ceq [Deployment.WindowsWorkerJob]::ProcessIdentity($listener.Id) -and
        $retained.Port -eq $endpoint.port -and [long]$retained.CreatedAt -gt 0 -and
        $retained.Address -ceq $(if ($Scenario -ceq 'listener-v4') { '127.0.0.1' } else { '::' })) `
        'Native listener lost original process, port, address or kernel binding time'
    $retained.Check()
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($endpoint.port)/" -NoProxy -MaximumRedirection 0 -TimeoutSec 5
    Assert ($response.StatusCode -eq 200 -and $response.Content -ceq 'owned-listener') 'Owned native listener is not IPv4 loopback accessible'
    $retained.Check()
    Refuses {
        $unexpected = [Deployment.WindowsRuntimeListener]::Retain([guid]$Ready.generation, $Ready.pid,
            '1:1', $Ready.launcherPid, $endpoint.port)
        $unexpected.Dispose()
    } 'Original runtime listener owner differs.'

    $foreign = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $foreign.Start()
    $foreignPort = $foreign.LocalEndpoint.Port
    Refuses { $unexpected = Retain $foreignPort; $unexpected.Dispose() } 'Runtime listener is outside the original Job.'
    Assert ($foreign.Server.IsBound -and -not $listener.HasExited -and -not $Owner.HasExited) 'Listener refusal stopped unrelated work'
    $foreign.Stop()
    $foreign = $null
    Refuses { $unexpected = Retain $foreignPort; $unexpected.Dispose() } 'Runtime listener is not ready.'

    if ($Scenario -ceq 'listener-v4') {
        $duplicate = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, $endpoint.port)
        $duplicate.Server.DualMode = $false
        $duplicate.Start()
        Refuses { $retained.Check() } 'Runtime listener is ambiguous.'
        $duplicate.Stop()
        $duplicate = $null
        $retained.Check()
    }
    [IO.File]::WriteAllText((Join-Path $Root 'listener-rebind'), 'rebind')
    $rebound = Wait-File (Join-Path $Root 'listener-rebound.json')
    Assert ($rebound.pid -eq $listener.Id -and $rebound.port -eq $endpoint.port -and -not $listener.HasExited) `
        'Listener fixture must rebind in the same original process'
    Refuses { $retained.Check() } 'Original runtime listener binding changed.'
    $fresh = Retain $endpoint.port
    Assert ($fresh.ListenerIdentity -ceq $retained.ListenerIdentity -and $fresh.CreatedAt -ne $retained.CreatedAt) `
        'Native listener failed to distinguish same-process close and rebind'
    $retained.Dispose()
    $retained = $null
    $fresh.Check()
    $null = [Deployment.WindowsRuntimeControl]::Exchange([guid]$Ready.generation, $Ready.pid, $Ready.identity, 'stop', 15000)
    Assert ($listener.WaitForExit(15000) -and -not $Owner.HasExited) 'Listener did not settle with its original Job'
    Refuses { $fresh.Check() } 'Original runtime listener domain is not running.'
    Write-Output "PASS: $Scenario retains native bind time and Job-owned process identity, refuses foreign/ambiguous/rebound sockets, and observes original settlement"
} finally {
    if ($retained) { $retained.Dispose() }
    if ($fresh) { $fresh.Dispose() }
    if ($foreign) { $foreign.Stop() }
    if ($duplicate) { $duplicate.Stop() }
    if ($listener) { $listener.Dispose() }
}
