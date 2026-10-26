# Native Retired Prepared Observation Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin and independently revalidate a real dead actor's exact prepared record without deleting evidence or granting lock authority.

**Architecture:** Extract native record construction from live-owner admission. The original publication entry still requires a live owner and empty handoff namespace. A separate read-only observer pins the supplied exact descriptor, requires the original owner absent, regenerates the entire native archive/task/state binding, and compares strict typed JSON twice while the files remain retained.

**Tech Stack:** PowerShell 7, System.Text.Json, native private file handles, existing real actor death Actions fixture.

---

### Task 1: Real native observer contract

**Files:**
- Modify: `tests/deployment-windows-history-handoff-entry.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Add mutually exclusive `-ObserveRetired` mode to the existing native
  fixture. It takes scalar prepared descriptor fields, retains the same
  archive scope and fresh controller watcher, then calls:

```powershell
Get-AgentsChatStoppedHistoryHandoffRetiredPrepared $scope @{
    path="inactive-handoff-$AttemptId-prepared.json"
    dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
} $AttemptId $ControllerPid $ControllerIdentity
```

  Load `windows-stopped-history-handoff-observation.ps1` only for this branch.
  Keep publication and held-publication branches unchanged. Observation
  returns a small status/descriptor response, never the entire prepared JSON.

- [x] In `resume-prepared-history`, after JS capture and original actor
  absence, call the native fixture using the original exact descriptor:

```javascript
assert.equal(observed.status, 'retired-prepared-handoff-observed');
assert.equal(observed.attemptId, previous.attemptId);
assert.deepEqual(observed.prepared, previous.prepared);
assert.equal(observed.runtimeAuthority, false);
assert.equal(observed.lockAuthority, false);
```

  Repeat with an incorrect inode and require the exact contextual observation
  failure, not arbitrary infrastructure failure. Preserve existing original
  bytes/hash/dev/ino/state/no-lock assertions, fresh-attempt refusal, and
  fixture-only deletion after all checks.

- [x] Add this eighth required executed receipt to the focused job:

```text
PASS: native retired prepared observation pins exact evidence after actual actor death without lock authority
```

- [x] Commit/push the tests and run the existing focused scenario:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

  Download actual job logs and require red due to the missing observation
  module after the real prepared publisher death.

### Task 2: Independent native derivation and pinned observation

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-record.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-observation.ps1`

- [x] Extract `Get-AgentsChatStoppedHistoryHandoffBinding(Context,AttemptId,Owner)`
  from the existing record function. Move its archive completion precondition,
  pinned old state, native task/SID/configuration observation and exact record
  construction together; retain native cleanup checks and the 1 MiB limit.
  The owner passed to this builder is data, not authority. Keep
  `Get-AgentsChatStoppedHistoryHandoffPreparedRecord` as the unchanged live API:
  reject every existing handoff namespace entry before and after construction,
  derive the live owner from the current original state updatedAt, and repeat
  live owner proof after construction.

- [x] Implement the independent observer with this interface:

```powershell
function Get-AgentsChatStoppedHistoryHandoffRetiredPrepared(
    [hashtable]$Context, $Descriptor, [string]$AttemptId,
    [int]$ControllerPid, [string]$ControllerIdentity
)
```

  Validate attempt GUID and descriptor exact path/size/hash/identity through
  existing retirement helpers. Pin through `Open-AgentsChatRetirementFile`.
  Use `Read-AgentsChatMaintenanceFields` for exact top-level keys and exact
  seven owner keys, retaining null values as JsonElements. Read original
  updatedAt from pinned native state, not from the prepared record.

  In each of two passes: require the fresh controller's native identity,
  exact sole prepared namespace entry, unchanged pinned bytes, original
  actor's native absence via `Get-AgentsChatStoppedHistoryHandoffRetiredOwner`,
  full native record reconstruction and strict recursive JSON equality.
  Derive previous operation and project only from the archive context.
  Require prepared attempt to equal the requested exact filename binding.

  Dispose parsed JsonDocuments in finally blocks. On failure poison the
  context and preserve the original exception:

```powershell
throw [InvalidOperationException]::new('Retired prepared handoff observation failed; retain evidence.', $_.Exception)
```

  Return only:

```powershell
[ordered]@{
    status='retired-prepared-handoff-observed'; attemptId=$AttemptId
    prepared=$Descriptor; runtimeAuthority=$false; lockAuthority=$false
}
```

- [x] Commit/push and repeat the focused Actions selection. Require all eight
  executed receipts and the complete focused job green, not application
  acceptance (commands-only intentionally skips actual application).
- [x] Run Windows Contracts-only for the changed native derivation and
  existing JS/owner/comparison contracts. Record both actual jobs and receipts
  before committing the acceptance evidence.

## Execution evidence

Red: `35c49668 / 40392405495`, actual stopped-history job `121816517008`.
Downloaded execution logs reach the distinct actor's `-ObserveRetired`
invocation after real prepared publisher death, then fail because the native
observation module is missing.

Green: `868802d7 / 40394833865`, actual job `121825003688`.
The focused job and actual archival/saved-entry takeover step succeed.
Downloaded execution logs contain all eight required execution receipts,
including native retired prepared observation and the original fresh-attempt
refusal. Correct original identity is accepted; incorrect inode is rejected;
original prepared bytes/dev/ino, state and absence of lock remain verified.
This commands-only selection is not actual application acceptance.

Same-SHA Windows Contracts: `40394838736`, job `121825029210`, succeeds.
Downloaded logs confirm executed live-owner, retired-owner and strict JSON
binding receipts. Both required native steps succeed.

## Self-review

No prepared file is rewritten, removed, renamed or treated as a lock.
Namespace allowance exists only in the independent read-only observer; the
live preparation/publication API continues to reject existing records.
The existing retired archive scope supplies task policy, disabled task,
runtime absence and original state proof. Observation is not abandonment
settlement, same-attempt reopening, retained production bridge, or public
inactive transaction admission.
