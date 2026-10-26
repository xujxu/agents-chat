# Native Handoff Lock Commit Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an exact new owner lock and immutable committed receipt from the original live prepared scope, preserving old state and ordinary refusal gates.

**Architecture:** A separate native lock-publisher role pins and fully revalidates the original live prepared record before any write. Native create-only directory/owner publication is retained in the same archive context. Only an explicitly retained handoff lock with checked handles, exact owner bytes, exact native identity and exact child inventory can coexist with that context's old archive proof; ordinary archive readers receive no exception. A separate committed record binds native lock directory/owner descriptors and original prepared digest.

**Tech Stack:** PowerShell 7, WindowsPrivateFile CreateDirectory/Publish, existing native archive/owner/JSON checks, focused Windows Actions.

---

### Task 1: Native commit fixture and real contracts

**Files:**
- Create: `tests/deployment-windows-history-handoff-commit.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Create a focused scalar-parameter fixture with Source, Control,
  ControllerPid/Identity, AttemptId, OperationId, Token, CreatedAt and exact
  prepared descriptor dev/ino/bytes/hash. Use the existing native Add-Type
  set, controller watcher and original HistoryArchive scope. Source
  `windows-stopped-history-handoff-commit.ps1`.

  First prove missing publisher role refuses without writes. Then set only
  `HistoryHandoffLockPublisher` and invoke:

```powershell
Publish-AgentsChatStoppedHistoryHandoffCommitted $scope @{
    path="inactive-handoff-$AttemptId-prepared.json"
    dev=$PreparedDev; ino=$PreparedIno; bytes=$PreparedBytes; sha256=$PreparedSha256
} $ControllerPid $ControllerIdentity $AttemptId $OperationId $Token $CreatedAt
```

  Output only its small committed descriptor; close the original retained
  scope/watcher through the established aggregate-cleanup convention.

- [ ] Extend the completed-history case after successful controlled reopen
  and close, while original prepared bytes/identity are still retained.
  Supply a changed token first and require explicit commit refusal plus no
  lock. Correct native publication must yield:

```text
inactive-handoff-<attempt>-committed.json
```

  Verify descriptor bytes/hash/dev/ino against the actual receipt. Decode it
  and compare exact root fields, original native prepared descriptor, original
  project/control/control identity/operation and prospective owner. Read
  actual lock/owner.json and require exact seven owner fields matching the
  prepared newOwner. Compare actual lock directory and owner file dev/ino/
  bytes/hash against the receipt; inspect creator bridge identity inside the
  live native fixture before close.

  Check ordinary native archive open and ordinary release refuse despite
  owner matching the current Node actor; assert original state, prepared
  bytes/identity, committed bytes/identity and lock bytes/identity unchanged.
  Repeated native commit must refuse and retain all evidence.

  Only after these exact checks may fixture cleanup unlink the exact commit
  and lock owner, remove the now-empty lock directory, and continue existing
  prepared cleanup/archive restoration. Production never performs this
  fixture cleanup.

- [ ] Add fourteenth required actual receipt:

```text
PASS: native handoff commit publishes exact new owner lock and immutable receipt while preserving old state and ordinary refusal gates
```

- [ ] Commit/push tests and dispatch focused history. Download actual logs;
  require missing native commit module after successful controlled reopen.

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

### Task 2: Shared native binding and exact scoped lock proof

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-namespace.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-live.ps1`
- Create: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-controller.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-observation.ps1`
- Modify: `scripts/deployment/windows-inactive-worker-cleanup.ps1`

- [ ] Move the existing exact namespace helper into its own native module;
  source it from both the retired observer and production controller.
  Replace the controller's single-file duplicate with the shared exact helper.
  No namespace policy changes.

- [ ] Extract the production controller's native live prepared binding check
  into `Assert-AgentsChatStoppedHistoryHandoffLivePreparedBinding(Context,
  AttemptId, OwnerRequest, File)`. Preserve live owner proof before/after,
  independent complete native record construction, strict JSON comparison,
  cleanup proof and document disposal. The caller retains exact namespace
  validation separately.

- [ ] Implement `Assert-AgentsChatStoppedHistoryHandoffLock(Context)`.
  Require independent native publisher role, fully archived prefix, existing
  HistoryCompletion and retained Context.HistoryHandoffLock. Check exact
  directory native identity and live owner request every invocation.

  Directory-only stage requires an empty exact lock directory. Owner stage
  requires exactly owner.json, no directories/pending/foreign/case variants,
  retained owner file checks, exact original owner text and captured native
  descriptor. The descriptor must match its retained handle; owner text must
  equal native serialization of the live exact prospective owner.

- [ ] Update stopped worker inventory only for that explicit retained role:
  if HistoryHandoffLock exists, invoke the full native lock verifier, then
  exclude only the already verified exact root lock entry and its verified
  children from the old retired-worker inventory. Every ordinary context
  lacks that retained lock and remains unchanged. Never add a filename-only
  exception or modify original old lock/state evidence.

### Task 3: Separate native committed publication

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-commit.ps1`
- Modify: `scripts/deployment/saved-worker-engine.mjs`
- Modify: `tests/deployment-saved-worker.test.mjs`

- [ ] Require HistoryHandoffLockPublisher role. Validate owner scalars through
  existing native owner construction against pinned original state updatedAt.
  Pin the original prepared descriptor and require exact sole prepared
  namespace plus complete shared live binding before any write.
  Require native current UTC not before the already validated owner createdAt;
  reject a future preparation timestamp before allocating a lock directory.

  Create only native `Control/lock`, retain its native directory handle and
  initial identity in Context.Files/HistoryHandoffLock. Recheck full old
  archive and empty exact new directory. Publish owner.json using native
  create-only Publish and the exact native owner JSON; retain handle and
  descriptor, then repeat full archive/live prepared/lock proof.

  Publish only this create-only immutable record:

```powershell
[ordered]@{
    version=1; phase='stopped-history-handoff-committed'; attemptId=$AttemptId
    control=$Context.Control; project=$Context.Project
    controlIdentity=$Context.HistoryRecord.controlIdentity
    previousOperationId=$Context.OperationId
    prepared=(Get-AgentsChatStoppedHandoffDescriptor $prepared $preparedName 1048576)
    newOwner=$owner
    lockIdentity=$lock.DirectoryIdentity
    lock=$lock.OwnerDescriptor
    creator=[ordered]@{
        pid=$ControllerPid; processIdentity=$ControllerIdentity
        bridgePid=$PID; bridgeIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
    }
    committedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}
```

  Filename is `inactive-handoff-<attempt>-committed.json`. Retain its handle.
  Require committedAt not before that same owner createdAt as well.
  Twice after publication require exact prepared+committed namespace, exact
  receipt bytes/native identity, shared live prepared binding, exact lock and
  full original archive proof. Return only the committed descriptor.
  Any failure poisons the context and throws
  `Handoff lock commit failed; retain evidence.` with original cause. Never
  undo a partial directory, owner, receipt or pending publication.

- [ ] Add new shared live/namespace dependencies to both explicit saved
  engine lists because the production preparation controller now sources
  them. Add lock/commit helpers when exposing them through a production saved
  commit entry, not as unused preparation dependencies.

- [ ] Commit/push, repeat focused and Windows Contracts-only on the same SHA.
  Require all fourteen executed receipts and full jobs green. Record and push
  red/green SHA/run/job evidence.

## Self-review and next gates

The scoped inventory allowance is validated native evidence, never authority
from a marker name or caller JSON. Ordinary readers, acquire/release and
reconciliation remain conservative. Old state is not written, task policy
is unchanged and no worker may start from this descriptor-only native role.
Next gates must kill real actors after directory/owner/committed publication,
then implement exact native interrupted-lock recovery before exposing commit
through a public command. State snapshot/transition and handoff-aware release
remain mandatory before public inactive routing.
