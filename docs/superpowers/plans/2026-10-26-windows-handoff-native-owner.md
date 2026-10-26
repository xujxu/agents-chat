# Windows Handoff Native Owner Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construct a prospective handoff owner only after native verification of its actual PID/start identity.

**Architecture:** Isolate owner-request validation from archive publication. Reuse native completion identity/GUID validation and the native process identity implementation; return owner fields without publishing anything or granting authority.

**Tech Stack:** PowerShell 7, existing WindowsWorkerJob native helper, GitHub Actions Windows Contracts.

---

## File map and scope

- Create `scripts/deployment/windows-stopped-history-handoff-owner.ps1`:
  owner request capture for the dedicated preparation role.
- Create `tests/deployment-windows-handoff-owner.ps1`: real live/foreign/dead
  process observations, not source-text assertions.
- Modify `.github/workflows/deployment-lifecycle.yml`: add an explicit native
  step in the Contracts job on Windows.

This is one unit of the approved native preparation design. Archive proof,
prepared publication, retained role lifetime and actual publisher-death
recovery remain separate gates. A valid owner object is not a lock capability.
Execution continues inline; every execution command is in Actions.

## Task 1: Establish the native red phase

- [ ] Create the test script with the following content:

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../scripts/deployment'
Add-Type -Path (Join-Path $source 'WindowsWorkerJob.cs')
. (Join-Path $source 'windows-stopped-history-handoff-owner.ps1')
function Assert-OwnerRefused([hashtable]$Request) {
    try { $null = New-AgentsChatStoppedHistoryHandoffOwner @Request }
    catch {
        if ($_.Exception.Message -notmatch 'Handoff prospective owner') { throw }
        return
    }
    throw 'Expected native prospective owner refusal.'
}
$request = @{
    Project=[IO.Path]::GetDirectoryName($PSScriptRoot)
    PreviousOperationId='11111111-1111-4111-8111-111111111111'
    AttemptId='22222222-2222-4222-8222-222222222222'
    OperationId='33333333-3333-4333-8333-333333333333'
    Token='44444444-4444-4444-8444-444444444444'
    CreatedAt='2026-10-26T00:00:01.000Z'
    PreviousUpdatedAt='2026-10-26T00:00:00.000Z'
    ControllerPid=$PID
    ControllerIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
}
$owner = New-AgentsChatStoppedHistoryHandoffOwner @request
if ($owner.pid -ne $PID -or $owner.processIdentity -cne $request.ControllerIdentity -or
    $owner.operationId -cne $request.OperationId -or $owner.token -cne $request.Token -or
    $owner.project -cne $request.Project -or $owner.createdAt -cne $request.CreatedAt -or
    $owner.version -ne 1 -or $owner.Count -ne 7) { throw 'Native owner binding differs.' }
$foreign = $request.Clone()
$foreign.ControllerIdentity = "$PID`:1"
Assert-OwnerRefused $foreign
$child = $null
try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $start.UseShellExecute = $false
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60')) {
        $start.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($start)
    $exited = $request.Clone()
    $exited.ControllerPid = $child.Id
    $exited.ControllerIdentity = [Deployment.WindowsWorkerJob]::ProcessIdentity($child.Id)
    $null = New-AgentsChatStoppedHistoryHandoffOwner @exited
    $child.Kill()
    if (-not $child.WaitForExit(15000)) { throw 'Original test process did not exit.' }
    Assert-OwnerRefused $exited
} finally {
    if ($child) {
        if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
}
Write-Host 'PASS: native prospective handoff owner binds live identity and refuses foreign or exited actors'
```

- [ ] Add a Windows-only Contracts step before the existing stability probe:

```yaml
      - name: Verify native prospective handoff owner identity
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          & (Get-Command pwsh).Source -NoProfile -NonInteractive -File ./tests/deployment-windows-handoff-owner.ps1
          if ($LASTEXITCODE -ne 0) { throw 'Native handoff owner identity contracts failed.' }
```

- [ ] Commit tests and workflow with required session trailers, push, dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Watch the returned run at 180-second intervals. Download the failing
  job logs and confirm the new native step fails because the production
  owner helper is missing. An unrelated failure is not red-phase acceptance.

## Task 2: Implement the native owner proof

- [ ] Create the production helper with the following complete content:

```powershell
. (Join-Path $PSScriptRoot 'windows-task-completion-records.ps1')

function New-AgentsChatStoppedHistoryHandoffOwner(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    foreach ($value in @($PreviousOperationId, $AttemptId, $OperationId, $Token)) {
        Assert-AgentsChatCompletionGuid $value
    }
    if (@($PreviousOperationId, $AttemptId, $OperationId | Select-Object -Unique).Count -ne 3 -or
        $Project -cnotmatch '^[A-Za-z]:\\' -or $Project.Length -gt 4096 -or
        $Project -match '[\x00\r\n]' -or [IO.Path]::GetFullPath($Project) -cne $Project -or
        $Project.Substring(3).Contains(':')) {
        throw 'Handoff prospective owner request differs.'
    }
    Assert-AgentsChatCompletionProcessIdentity $ControllerPid $ControllerIdentity
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::AssumeUniversal
    $created = [DateTimeOffset]::ParseExact($CreatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    $previous = [DateTimeOffset]::ParseExact($PreviousUpdatedAt, 'yyyy-MM-ddTHH:mm:ss.fffZ', $culture, $style)
    if ($created -lt $previous) { throw 'Handoff prospective owner timestamp is backdated.' }
    foreach ($pass in @(1, 2)) {
        try { $actual = [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) }
        catch {
            throw [InvalidOperationException]::new('Handoff prospective owner is unavailable.', $_.Exception)
        }
        if ($actual -cne $ControllerIdentity) { throw 'Handoff prospective owner identity differs.' }
    }
    return [ordered]@{
        version=1; token=$Token; project=$Project; operationId=$OperationId
        pid=$ControllerPid; processIdentity=$ControllerIdentity; createdAt=$CreatedAt
    }
}
```

- [ ] Commit/push with required trailers and repeat the exact dispatch from
  Task 1. Watch at 180-second intervals, inspect the actual native step and
  required PASS receipt, and require the complete Windows Contracts job green.
- [ ] Record red/green SHAs, run IDs and actual job IDs in this plan; commit
  and push the evidence.

## Execution evidence

Red phase: `32418d56 / 40357058979`, Windows Contracts job
`121692259874`, fails in the exact new native owner step because
`windows-stopped-history-handoff-owner.ps1` does not exist. Downloaded failed
logs confirm this expected missing-implementation boundary. The native
owner helper is now implemented; green-phase acceptance is pending.

## Self-review

The process identity lookup is native and failures are explicit, with their
original cause retained. No missing-process sentinel or guessed identity is
accepted. This proof is only an observation: the subsequent preparation role
must retain its owner watcher and recheck identity at publication boundaries.
The helper never writes state, lock or receipt files.
