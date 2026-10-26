# Windows Handoff Native Record Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the prepared record from a real retained native archive proof, rather than caller-supplied archive JSON.

**Architecture:** A native record builder consumes the existing read-only archive context and scalar prospective-owner inputs. A real completed-history actor invokes it through a fixture-only watched native process, then independently captures and verifies the returned record. No publication or admission authority is added.

**Tech Stack:** PowerShell 7, existing native archive scope and owner helper, node:assert, focused GitHub Actions fixture.

---

## Scope and files

Prerequisites: the exact prepared JS contract and native owner proof have
separate accepted Windows Contracts evidence. Execution remains inline.

- Create `scripts/deployment/windows-stopped-history-handoff-record.ps1`:
  derive native file descriptors, original state, disabled task and owner.
- Create `tests/deployment-windows-history-handoff-entry.ps1`: fixture-only
  watched native reader, using the same Add-Type closure as the completion
  recovery controller, original archive scope and normal close function.
- Modify `tests/deployment-windows-lost-runtime-session.mjs` inside
  `resume-completed-history`: invoke that fixture with scalar owner values;
  capture its returned record using the accepted JS contract; compare original
  state/intent/completion bytes and actual actor identity.
- Modify `.github/workflows/deployment-lifecycle.yml`: require the exact new
  native-derivation PASS receipt in the existing focused history job.

## Task 1: Real-fixture red phase

- [ ] Add a fixture entry taking Source, Control, ControllerPid,
  ControllerIdentity, AttemptId, OperationId, Token and CreatedAt. Load the
  existing native controller's Add-Type closure, then the worker cleanup and
  new record modules. Retain an owner watcher, open
  `Open-AgentsChatStoppedWorkerCleanup -HistoryArchive`, call the record
  builder below, and print only its compressed JSON. Close the original
  proof and watcher in finally.

Complete fixture content:

```powershell
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Control,
    [Parameter(Mandatory)][int]$ControllerPid,
    [Parameter(Mandatory)][string]$ControllerIdentity,
    [Parameter(Mandatory)][string]$AttemptId,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Token,
    [Parameter(Mandatory)][string]$CreatedAt
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path @(
    'WindowsWorkerJob.cs', 'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs',
    'WindowsRuntimeControl.cs', 'WindowsPrivateFile.cs', 'WindowsPrivateFile.SourceSecurity.cs',
    'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'WindowsRuntimeListener.cs' |
    ForEach-Object { Join-Path $Source $_ })
. (Join-Path $Source 'windows-inactive-worker-cleanup.ps1')
. (Join-Path $Source 'windows-stopped-history-handoff-record.ps1')
$scope = $watch = $null
try {
    $watch = [Deployment.WindowsWorkerLauncher]::WatchOwnerUntilExit($ControllerPid, $ControllerIdentity)
    $scope = Open-AgentsChatStoppedWorkerCleanup $Control -HistoryArchive
    $record = Get-AgentsChatStoppedHistoryHandoffPreparedRecord $scope $ControllerPid $ControllerIdentity `
        $AttemptId $OperationId $Token $CreatedAt
    [Console]::Out.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress))
} finally {
    try { if ($scope) { Close-AgentsChatTaskCompletionProof $scope } }
    finally { if ($watch) { $watch.Dispose() } }
}
```

The exact invocation and assertions in the existing completed-history branch:

```js
const attemptId = randomUUID();
const operationId = randomUUID();
const token = randomUUID();
const actorIdentity = await processIdentity(process.pid);
const nativeRecord = await promisify(execFile)(pwsh, [
  '-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
  '-Source', source, '-Control', control,
  '-ControllerPid', String(process.pid), '-ControllerIdentity', actorIdentity,
  '-AttemptId', attemptId, '-OperationId', operationId,
  '-Token', token, '-CreatedAt', new Date().toISOString(),
], { timeout: 45000, maxBuffer: 2 * 1024 ** 2, windowsHide: true });
assert.equal(nativeRecord.stderr, '');
const { captureWindowsStoppedHistoryHandoffPrepared } =
  await load('windows-stopped-history-handoff-record.mjs');
const prepared = captureWindowsStoppedHistoryHandoffPrepared(JSON.parse(nativeRecord.stdout));
assert.equal(prepared.attemptId, attemptId);
assert.equal(prepared.newOwner.operationId, operationId);
assert.equal(prepared.newOwner.token, token);
assert.equal(prepared.newOwner.pid, process.pid);
assert.equal(prepared.newOwner.processIdentity, actorIdentity);
assert.equal(prepared.oldState, state.toString('utf8'));
assert.equal(prepared.intent.sha256, createHash('sha256').update(originalIntent).digest('hex'));
assert.equal(prepared.completion.sha256, createHash('sha256').update(completionBytes).digest('hex'));
assert.equal((await readdir(control)).some(name => name.toLowerCase().startsWith('inactive-handoff-')), false);
assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
console.log('PASS: native stopped-history preparation derives exact archive and live prospective owner without publication');
```

- [ ] Commit test/fixture/workflow changes with required trailers and push.
  Dispatch the exact focused fixture:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

- [ ] Watch the returned run at 180-second intervals. Download job logs;
  require failure because the new native record module is missing, not
  because an earlier fixture boundary or tool setup failed.

## Task 2: Native derivation

- [ ] Create the native record module with this complete implementation:

```powershell
. (Join-Path $PSScriptRoot 'windows-stopped-history-handoff-owner.ps1')

function Get-AgentsChatStoppedHandoffDescriptor($File, [string]$Name) {
    $File.Check()
    $identity = $File.CaptureIdentity()
    $descriptor = [ordered]@{
        path=$Name; dev=$identity.Dev; ino=$identity.Ino
        bytes=$File.ByteLength; sha256=$File.Sha256
    }
    Assert-AgentsChatRetirementDescriptor $descriptor $Name 65536
    return $descriptor
}

function Get-AgentsChatStoppedHistoryHandoffPreparedRecord(
    [hashtable]$Context, [int]$ControllerPid, [string]$ControllerIdentity,
    [string]$AttemptId, [string]$OperationId, [string]$Token, [string]$CreatedAt
) {
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    $intentName = "retired-$($Context.OperationId)-inactive-rollback-history-intent.json"
    $completionName = "retired-$($Context.OperationId)-inactive-rollback-history-complete.json"
    if (-not $Context.ContainsKey('HistoryCompletion') -or
        $Context.HistoryIntentPath -cne (Join-Path $Context.Control $intentName)) {
        throw 'Native handoff preparation requires completed original archival.'
    }
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-handoff-*') { throw 'Existing handoff requires explicit settlement.' }
    }
    $state = Open-AgentsChatRetirementFile $Context $Context.TaskRecord.checkpoint.state 'state.json'
    $oldState = $state.ReadText()
    $document = [Text.Json.JsonDocument]::Parse($oldState)
    try { $updated = $document.RootElement.GetProperty('updatedAt').GetString() }
    finally { $document.Dispose() }
    $request = @{
        Project=$Context.Project; PreviousOperationId=$Context.OperationId
        AttemptId=$AttemptId; OperationId=$OperationId; Token=$Token; CreatedAt=$CreatedAt
        PreviousUpdatedAt=$updated; ControllerPid=$ControllerPid; ControllerIdentity=$ControllerIdentity
    }
    $owner = New-AgentsChatStoppedHistoryHandoffOwner @request
    $task = $Context.Folder.GetTask($Context.TaskName)
    $user = [string]$task.Definition.Principal.UserId
    $sid = if ($user -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($user) }
        else { ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]) }
    $configuration = $Context.Admission.configuration.GetString()
    if ($Context.ContainsKey('RuntimeHandoffReleased')) {
        $configuration = Join-Path $Context.RuntimeHandoffDirectory 'configuration.json'
    }
    $record = [ordered]@{
        version=1; phase='stopped-history-handoff-prepared'; attemptId=$AttemptId
        control=$Context.Control; project=$Context.Project
        controlIdentity=$Context.HistoryRecord.controlIdentity
        previousOperationId=$Context.OperationId; operation='update'; oldState=$oldState
        state=(Get-AgentsChatStoppedHandoffDescriptor $state 'state.json')
        intent=(Get-AgentsChatStoppedHandoffDescriptor $Context.HistoryIntent $intentName)
        completion=(Get-AgentsChatStoppedHandoffDescriptor $Context.HistoryCompletion $completionName)
        newOwner=$owner
        observation=[ordered]@{
            status='inactive-task-observed'; runtimeAuthority=$false
            project=$Context.Project; taskName=$Context.TaskName; definition=$Context.Definition
            securityDescriptor=$Context.SecurityDescriptor; principalSid=$sid.Value; enabled=$false
            configuration=$configuration; configurationSha256=$Context.RetiredRuntime.configurationSha256
            runtime=$null; retiredRuntime=$Context.RetiredRuntime
        }
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($record | ConvertTo-Json -Depth 12 -Compress)) -gt 1048576) {
        throw 'Native prepared handoff response is oversized.'
    }
    $null = New-AgentsChatStoppedHistoryHandoffOwner @request
    $null = Assert-AgentsChatStoppedWorkerCleanup $Context
    foreach ($item in Get-ChildItem -LiteralPath $Context.Control -Force) {
        if ($item.Name -like 'inactive-handoff-*') { throw 'Handoff appeared during native preparation.' }
    }
    return $record
}
```

This first unit derives an update request only. Add a validated explicit
command input before reusing it for public deploy; do not claim deploy
support from this fixture. The builder's output is not published or accepted
by ordinary admission.

- [ ] Commit/push with required trailers and repeat the focused dispatch.
  Inspect actual logs for all existing four required death receipts plus
  the new derivation receipt. Require the focused native job green.
- [ ] Record exact red/green SHAs, run IDs and actual job IDs here and
  commit/push the evidence.

## Execution evidence

Red phase: `db57b371 / 40364975288`, job `121720106994`, reaches
`resume-completed-history` and fails at the fixture invocation because
`windows-stopped-history-handoff-record.ps1` is missing. Downloaded logs
show actual original controller identity and new prospective owner GUIDs
at this intended boundary, not an earlier archive failure. Native derivation
is now implemented; green-phase acceptance is pending.

## Self-review and next gate

Original state and archive metadata are derived from pinned native files.
The actual disabled task and principal are observed under the retained
archive proof; relocated configuration uses the proved physical bundle.
The caller supplies no state, task definition, digest or file identity.
Process and original archive proof are rechecked before return.

Create-only prepared publication, retained dedicated role, publication-death
recovery, native lock publication and public routing remain unimplemented.
Existing method-frame limits and reader/writer/publisher permissions are not
changed by this derivation unit.
