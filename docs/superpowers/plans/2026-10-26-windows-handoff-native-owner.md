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

- [x] Create the test script with the following content:

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

- [x] Add a Windows-only Contracts step before the existing stability probe:

```yaml
      - name: Verify native prospective handoff owner identity
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          & (Get-Command pwsh).Source -NoProfile -NonInteractive -File ./tests/deployment-windows-handoff-owner.ps1
          if ($LASTEXITCODE -ne 0) { throw 'Native handoff owner identity contracts failed.' }
```

- [x] Commit tests and workflow with required session trailers, push, dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

- [x] Watch the returned run at 180-second intervals. Download the failing
  job logs and confirm the new native step fails because the production
  owner helper is missing. An unrelated failure is not red-phase acceptance.

## Task 2: Implement the native owner proof

- [x] Create the production helper with the following complete content:

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

- [x] Commit/push with required trailers and repeat the exact dispatch from
  Task 1. Watch at 180-second intervals, inspect the actual native step and
  required PASS receipt, and require the complete Windows Contracts job green.
- [x] Record red/green SHAs, run IDs and actual job IDs in this plan; commit
  and push the evidence.

## Execution evidence

Red phase: `32418d56 / 40357058979`, Windows Contracts job
`121692259874`, fails in the exact new native owner step because
`windows-stopped-history-handoff-owner.ps1` does not exist. Downloaded failed
logs confirm this expected missing-implementation boundary. The native
owner helper is now implemented; green-phase acceptance is pending.

Green phase: `c5c2233e / 40359173249`, job `121699658963`, passes the
complete Windows Contracts selection and the dedicated native owner step.
Downloaded actual job logs contain the required PASS receipt for a live
identity, a foreign start identity and the same real process after exit.
This accepts the native owner observation only; no preparation publication,
retained handoff role or lock authority is added by this helper.

## Self-review

The process identity lookup is native and failures are explicit, with their
original cause retained. No missing-process sentinel or guessed identity is
accepted. This proof is only an observation: the subsequent preparation role
must retain its owner watcher and recheck identity at publication boundaries.
The helper never writes state, lock or receipt files.

## Follow-on task: Native retired-owner observation

This is the prerequisite for sealing an abandoned prepared attempt, not
abandonment publication or ownership transfer. Reuse the original native
absence proof; do not treat a missing JS process identity as authorization.

- [x] In the native test script, add a refusal assertion for a live original
  actor using the new retired-owner function:

```powershell
function Assert-RetiredOwnerRefused([hashtable]$Request) {
    try { $null = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @Request }
    catch {
        if ($_.Exception.Message -notmatch 'Handoff retired owner') { throw }
        return
    }
    throw 'Expected live original actor to prevent retired owner observation.'
}
Assert-RetiredOwnerRefused $request
```

- [x] Retain `$liveChild = New-AgentsChatStoppedHistoryHandoffOwner @exited`
  before the existing child kill. After its actual exit and existing live
  owner refusal, add:

```powershell
$retired = Get-AgentsChatStoppedHistoryHandoffRetiredOwner @exited
foreach ($key in $liveChild.Keys) {
    if ($retired[$key] -cne $liveChild[$key]) { throw 'Retired owner fields changed after actual actor exit.' }
}
Write-Host 'PASS: native retired handoff owner requires actual original actor absence without granting authority'
```

- [x] Commit/push tests with required trailers and dispatch the existing
  Windows Contracts-only selection. Inspect the actual native owner step:
  expected red is a missing retired-owner function, not acceptance of a live
  actor or unrelated tool failure.

- [x] Refactor the existing native owner helper: load
  `windows-task-completion-proof.ps1` instead of its records-only source;
  rename the existing validation body to
  `Get-AgentsChatStoppedHistoryHandoffOwnerRecord` and remove only its live
  identity loop. Keep all GUID, path, timestamp and identity-shape validation
  and the exact seven returned owner fields unchanged.

Add these complete wrappers, retaining the original live API signature:

```powershell
function New-AgentsChatStoppedHistoryHandoffOwner(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $owner = Get-AgentsChatStoppedHistoryHandoffOwnerRecord @PSBoundParameters
    foreach ($pass in @(1, 2)) {
        try { $actual = [Deployment.WindowsWorkerJob]::ProcessIdentity($ControllerPid) }
        catch {
            throw [InvalidOperationException]::new('Handoff prospective owner is unavailable.', $_.Exception)
        }
        if ($actual -cne $ControllerIdentity) { throw 'Handoff prospective owner identity differs.' }
    }
    return $owner
}

function Get-AgentsChatStoppedHistoryHandoffRetiredOwner(
    [string]$Project, [string]$PreviousOperationId, [string]$AttemptId,
    [string]$OperationId, [string]$Token, [string]$CreatedAt,
    [string]$PreviousUpdatedAt, [int]$ControllerPid, [string]$ControllerIdentity
) {
    $owner = Get-AgentsChatStoppedHistoryHandoffOwnerRecord @PSBoundParameters
    foreach ($pass in @(1, 2)) {
        try { Assert-AgentsChatCompletionProcessAbsent $ControllerPid $ControllerIdentity }
        catch {
            throw [InvalidOperationException]::new('Handoff retired owner remains live or unverifiable.', $_.Exception)
        }
    }
    return $owner
}
```

- [x] Commit/push and repeat Windows Contracts-only validation. Require the
  existing live/foreign/exited receipt plus the new retired-owner receipt.
  Record SHA/run/job evidence here and commit/push it.

The new function returns an observation only. A future abandonment publisher
must also pin the exact prepared record, reprove the original archived state,
bind the acting recovery controller and preserve all existing evidence.

### Retired-owner execution evidence

Red: `6256d69f / 40382967258`, Windows Contracts job `121783767031`.
Downloaded actual logs show the native owner test fails because
`Get-AgentsChatStoppedHistoryHandoffRetiredOwner` is not recognized.

Green: `ae01fb9e / 40384914098`, Windows Contracts job `121790535521`.
The complete job and dedicated native owner step succeed. Downloaded
execution logs contain both the original live/foreign/exited owner receipt
and the new actual-original-actor-absence receipt. The seven captured owner
fields survive real child termination unchanged. No lock, prepared-record
reopening or abandonment publication is authorized by this observation.
