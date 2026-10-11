function Get-WindowsRestoreTcpProbe([string]$Address) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync([Net.IPAddress]::Parse($Address), 443)
        $tasks = [Threading.Tasks.Task[]]@($connect, [Threading.Tasks.Task]::Delay(5000))
        $completed = [Threading.Tasks.Task]::WhenAny($tasks).GetAwaiter().GetResult()
        if (-not [object]::ReferenceEquals($completed, $connect)) {
            return [pscustomobject]@{ Connected = $false; ErrorCode = 'TimedOut' }
        }
        try { [void]$connect.GetAwaiter().GetResult() }
        catch {
            $cause = $_.Exception
            while ($cause.InnerException) { $cause = $cause.InnerException }
            if ($cause -isnot [Net.Sockets.SocketException]) { throw }
            return [pscustomobject]@{ Connected = $false; ErrorCode = $cause.SocketErrorCode.ToString() }
        }
        return [pscustomobject]@{ Connected = $true; ErrorCode = $null }
    } finally { $client.Dispose() }
}

function Assert-WindowsRestoreEgressBlocked($Guard) {
    foreach ($profile in Get-NetFirewallProfile) {
        if ($profile.Enabled -ne 'True') { throw 'Restore egress denial requires enabled firewall profiles.' }
    }
    for ($i = 0; $i -lt $Guard.RuleNames.Count; $i++) {
        $rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $Guard.RuleNames[$i] -ErrorAction Stop
        if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block' -or
            $rule.Profile -ne 'Any') { throw 'Restore egress rule is not effective.' }
        $application = $rule | Get-NetFirewallApplicationFilter
        $addresses = $rule | Get-NetFirewallAddressFilter
        if ($application.Program -ne $Guard.Programs[$i] -or
            (@($addresses.RemoteAddress | Sort-Object) -join ',') -ne
            (@($Guard.RemoteAddress | Sort-Object) -join ',')) { throw 'Restore egress rule filters changed.' }
    }
    $text = & $Guard.Node (Join-Path $PSScriptRoot 'deployment-windows-egress-probe.mjs') blocked $Guard.Address
    if ($LASTEXITCODE -ne 0) { throw 'Restore Node executable external-denial probe failed.' }
    $nodeProbe = $text | ConvertFrom-Json
    if ($nodeProbe.connected -or $nodeProbe.address -ne $Guard.Address) { throw 'Node egress probe binding changed.' }
    $powershellProbe = Get-WindowsRestoreTcpProbe $Guard.Address
    if ($powershellProbe.Connected -or $powershellProbe.ErrorCode -notin @('AccessDenied', 'TimedOut')) {
        throw "PowerShell egress denial was not established: $($powershellProbe.ErrorCode)"
    }
    [Console]::Error.WriteLine("PASS: effective restore executable egress blocks; Node=$($nodeProbe.errorCode), PowerShell=$($powershellProbe.ErrorCode)")
}

function Disable-WindowsRestoreEgressBlock($Guard) {
    $errors = [Collections.Generic.List[Exception]]::new()
    foreach ($name in $Guard.RuleNames) {
        try { Remove-NetFirewallRule -Name $name -ErrorAction Stop }
        catch { $errors.Add($_.Exception) }
    }
    foreach ($profile in $Guard.Profiles) {
        try {
            Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled -ErrorAction Stop
            if ((Get-NetFirewallProfile -Name $profile.Name).Enabled -ne $profile.Enabled) {
                throw 'Original firewall profile setting was not restored.'
            }
        }
        catch { $errors.Add($_.Exception) }
    }
    if ($errors.Count) { throw [AggregateException]::new('Restore egress fixture cleanup failed.', $errors) }
}

function Enable-WindowsRestoreEgressBlock([string]$Node, [string]$Pwsh, [string]$Git) {
    $text = & $Node (Join-Path $PSScriptRoot 'deployment-windows-egress-probe.mjs') allowed
    if ($LASTEXITCODE -ne 0) { throw 'Cannot establish positive Node external-connectivity canary.' }
    $probe = $text | ConvertFrom-Json
    $powershellProbe = Get-WindowsRestoreTcpProbe $probe.address
    if (-not $powershellProbe.Connected) { throw 'Cannot establish positive PowerShell external-connectivity canary.' }
    $gitExec = & $Git --exec-path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate Git network helpers for egress denial.' }
    $gitHelpers = @(Get-ChildItem -LiteralPath $gitExec -Filter 'git-remote-*.exe' -File)
    if (-not $gitHelpers.Count) { throw 'Git network helper inventory is empty.' }
    $programs = @(@($Node, $Pwsh, $Git,
        (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')) +
        @($gitHelpers | ForEach-Object FullName) |
        ForEach-Object { (Get-Item -LiteralPath $_ -ErrorAction Stop).FullName } | Select-Object -Unique)
    $guard = [pscustomobject]@{
        Node = $Node
        Address = $probe.address
        Programs = $programs
        Profiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled)
        RuleNames = [Collections.Generic.List[string]]::new()
        RemoteAddress = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255',
            '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
    }
    try {
        foreach ($program in $programs) {
            $name = "agents-chat-restore-egress-$([guid]::NewGuid())"
            New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Block `
                -Program $program -Profile Any -Enabled True -RemoteAddress $guard.RemoteAddress -ErrorAction Stop | Out-Null
            $guard.RuleNames.Add($name)
        }
        foreach ($profile in $guard.Profiles) {
            if ($profile.Enabled -ne 'True') { Set-NetFirewallProfile -Name $profile.Name -Enabled True -ErrorAction Stop }
        }
        Assert-WindowsRestoreEgressBlocked $guard
        return $guard
    } catch {
        $failure = $_.Exception
        try { Disable-WindowsRestoreEgressBlock $guard }
        catch { throw [AggregateException]::new('Restore egress setup and cleanup failed.', [Exception[]]@($failure, $_.Exception)) }
        throw $failure
    }
}
