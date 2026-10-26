# Native Abandoned Handoff Observation Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revalidate an exact immutable terminal receipt and its original prepared record under a third native actor after actual publisher death, without granting lock authority.

**Architecture:** A new read-only observer pins both supplied native descriptors, checks the exact two-file namespace, and reuses complete native prepared binding proof. It validates the terminal creator through existing native retirement creator proof and compares the entire receipt against an independently reconstructed archive binding. Existing publishers and one-record observation remain fail-closed.

**Tech Stack:** PowerShell 7, native retirement proof, exact JSON binding, real three-actor Actions fixture.

---

### Task 1: Native third-actor contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-entry.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add mutually exclusive `-ObserveAbandoned` fixture mode and scalar
  `TerminalDev`, `TerminalIno`, `TerminalBytes`, `TerminalSha256` parameters.
  Load `windows-stopped-history-handoff-abandoned-observation.ps1` only for
  this branch and invoke:

```powershell
Get-AgentsChatStoppedHistoryHandoffAbandoned $scope @{
    path="inactive-handoff-$AttemptId-prepared.json"
    dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
} @{
    path="inactive-handoff-$AttemptId-abandoned.json"
    dev=$TerminalDev; ino=$TerminalIno; bytes=$TerminalBytes; sha256=$TerminalSha256
} $AttemptId $ControllerPid $ControllerIdentity
```

- [ ] Extend `resume-abandoned-history` after actual publisher/bridge absence
  checks. Invoke the native observer with both original descriptors and assert:

```javascript
assert.equal(observed.status, 'abandoned-handoff-observed');
assert.equal(observed.attemptId, previous.attemptId);
assert.deepEqual(observed.prepared, previous.prepared);
assert.deepEqual(observed.terminal, previous.terminal);
assert.equal(observed.runtimeAuthority, false);
assert.equal(observed.lockAuthority, false);
```

  Repeat with an incorrect terminal inode, requiring
  `Abandoned handoff observation failed; retain evidence.` Existing
  fresh-publisher refusal, unchanged bytes/dev/ino/state/no-lock assertions
  remain in place before fixture-only cleanup.

- [ ] Add eleventh required executed receipt:

```text
PASS: native abandoned handoff observation revalidates exact terminal and prepared evidence under a third actor without lock authority
```

- [ ] Commit/push tests; dispatch the focused scenario below. Download actual
  logs and require red because the new native observation module is missing
  after actual terminal publisher death.

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

### Task 2: Native exact terminal proof

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-abandoned-observation.ps1`

- [ ] Implement:

```powershell
function Get-AgentsChatStoppedHistoryHandoffAbandoned(
    [hashtable]$Context, $PreparedDescriptor, $TerminalDescriptor,
    [string]$AttemptId, [int]$ControllerPid, [string]$ControllerIdentity
)
```

  Source the accepted prepared observation module. Validate canonical attempt
  and controller identity. Pin exact prepared (maximum 1 MiB) and terminal
  (maximum 65536 bytes) descriptors using existing retirement helpers.
  The terminal receipt contains no null values: decode with the existing
  duplicate-safe retirement reader; require exactly version, phase, attemptId,
  control, project, controlIdentity, previousOperationId, prepared, creator and
  settledAt. Require settledAt string with exact canonical UTC milliseconds,
  not before pinned prepared.newOwner.createdAt.

  Twice: require exact prepared+terminal namespace; validate terminal creator
  with `Assert-AgentsChatRetirementCreator` and acting controller arguments,
  then run the accepted retained prepared binding check against the fresh
  controller. Verify terminal retained bytes and compare strict typed JSON
  against an independently reconstructed record:

```powershell
[ordered]@{
    version=1; phase='stopped-history-handoff-abandoned'; attemptId=$AttemptId
    control=$Context.Control; project=$Context.Project
    controlIdentity=$Context.HistoryRecord.controlIdentity
    previousOperationId=$Context.OperationId
    prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
    creator=$record.creator; settledAt=$record.settledAt
}
```

  Original creator fields are data accepted only after native identity-shape
  and process-absence proof; timestamps are data, not operation authority.
  Repeat native creator proof and full archive checks, then exact namespace.
  Dispose parsed documents. On failure poison context and throw the explicit
  contextual observation error with original cause. Preserve every file.

  Return only the two freshly captured descriptors, attemptId, status
  `abandoned-handoff-observed`, runtimeAuthority false and lockAuthority false.

- [ ] Commit/push and repeat focused Actions; require all eleven executed
  receipts and complete job green. Run Windows Contracts-only on the same SHA.
- [ ] Record real SHA/run/job evidence and push acceptance.

## Self-review

No live-publication API gains namespace exceptions. This reader has no
publisher role, does not rewrite old files, cannot settle a different attempt,
and never returns the entire prepared JSON over the shared transport.
It validates retained terminal evidence only; next-attempt admission,
same-attempt reopening, committed lock publication, state transition and
pending-publication death remain separate gates.
