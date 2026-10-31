function Open-AgentsChatTaskListener {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][int]$Port
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    if ($Context.Busy) { throw 'Task maintenance refused: busy.' }
    $Context.Busy = $true
    try {
        $Context.Stage = 'listener-activation'
        if (-not $Context.Activated -or $Port -lt 1 -or $Port -gt 65535) {
            throw 'Listener observation requires original active authority and explicit port.'
        }
        Test-AgentsChatActiveTaskContext $Context
        $Context.Stage = 'listener-retention'
        if ($Context.Listener) {
            if ($Context.Listener.Port -ne $Port) { throw 'Original retained listener port differs.' }
            $Context.Listener.Check()
        } else {
            $runtime = $Context.ActivationRuntime
            try {
                $Context.Listener = [Deployment.WindowsRuntimeListener]::Retain(
                    [guid]$runtime.generation, $runtime.pid, $runtime.identity, $runtime.launcherPid, $Port)
            } catch {
                if ($_.Exception.GetBaseException() -isnot [Deployment.WindowsRuntimeListenerNotReadyException]) { throw }
                Test-AgentsChatActiveTaskContext $Context
                return [pscustomobject]@{ status='not-ready' }
            }
            $Context.Files.Add($Context.Listener)
        }
        Test-AgentsChatActiveTaskContext $Context
        return [pscustomobject][ordered]@{
            status='retained'; generation=$Context.ActivationRuntime.generation; port=$Port
            pid=$Context.Listener.ListenerPid; identity=$Context.Listener.ListenerIdentity
            address=$Context.Listener.Address; createdAt=$Context.Listener.CreatedAt; pairedRecords=$Context.Listener.PairedRecords
        }
    } catch {
        $Context.Poisoned = $true
        throw "Task maintenance refused: $($Context.Stage)."
    } finally { $Context.Busy = $false }
}
