# Retained Native Handoff Preparation Bridge Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the accepted native preparation publisher through a retained production bridge under the original Windows admission, returning only small descriptors.

**Architecture:** Add a dedicated native controller rather than expanding the completion recovery controller. Scalar original-owner inputs are fixed at startup; only sequenced check/publish/close requests are accepted. Before publication the native scope proves empty namespace and original archival binding; afterward it retains and revalidates its exact published descriptor, live owner and full native binding. A focused JS client retains original admission checks and validates small typed responses.

**Tech Stack:** Existing WindowsControllerTransport/workerWire, PowerShell 7, native archive scope and create-only publisher, original Windows admission.

---

### Task 1: Descriptor and actual production contracts

**Files:**
- Modify: `tests/deployment-windows-inactive-task.test.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add a focused descriptor contract for exported
  `captureWindowsStoppedHistoryHandoffPreparedDescriptor(input, attemptId)`.
  Accept an exact prepared filename and native identities up to 1 MiB;
  reject overflow, fractional byte counts, foreign filename, noncanonical
  decimal identities and identity integer overflow. Returned record must be
  detached/frozen.

- [ ] In `resume-completed-history`, after existing fixture publication
  verification and exact fixture-only cleanup, call:

```javascript
const scope = await openWindowsStoppedHistoryHandoffPreparation({
  ...options, project: originalState.project,
  previousOperationId: originalState.operationId, operation: 'update',
  attemptId: randomUUID(), operationId: randomUUID(), token: randomUUID(),
  createdAt: new Date().toISOString(),
});
```

  Reject copied admission and pre-aborted signal first. Require exact ready
  observation, live native bridge identity, descriptor-only publish result,
  file hash/dev/ino/bytes, JS prepared capture matching original state and
  current Node owner, post-publish check and repeat publication refusal.
  After close, require unchanged evidence and no lock, then fixture-only
  cleanup.

- [ ] Replace the raw `-Publish -Hold` transport in `crash-prepared-history`
  with this production scope. Retain the same small held payload containing
  scope.identity and the published descriptor. Existing actual prepared and
  abandoned publisher death boundaries must keep passing without fixture
  publication being misrepresented as production bridge coverage.

- [ ] Add twelfth required actual receipt:

```text
PASS: production retained native preparation bridge publishes descriptor-only evidence under original admission without lock authority
```

- [ ] Commit/push tests and dispatch both focused history and Contracts-only.
  Require actual missing-production-module/export red, not a fixture failure.

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

### Task 2: Retained native controller

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-controller.ps1`

- [ ] Follow existing native controller bootstrap, Add-Type list, exact
  controller watcher, stage-aware stderr and aggregate cleanup pattern.
  Accept Control, ControllerPid/Identity, AttemptId, OperationId, Token,
  CreatedAt scalar startup parameters. Open completed original archive and
  enable only HistoryHandoffPreparer role.

  Derive the initial record through the accepted live preparation helper and
  capture the original owner request using pinned state.updatedAt. Ready
  frame keeps existing type/pid/processIdentity/control/controllerIdentity
  fields and this small value:

```powershell
[ordered]@{
    status='stopped-history-handoff-ready'; attemptId=$AttemptId
    previousOperationId=$scope.OperationId; project=$scope.Project; prepared=$null
}
```

- [ ] Read maximum 4096-byte exact id/method frames. Require strictly next id
  and one of check/publish/close. Check original actor identity every request.
  Publish invokes only the accepted native create-only preparer, pins the
  returned descriptor, and retains it until close or actor death.

  Before publication check the original empty namespace through the existing
  native prepared record helper. After publication check exact one-file
  namespace, retained file hash/identity, current native owner request and
  independent native binding via strict typed JSON comparison. Keep existing
  frame limits; never return the prepared JSON.

  Published observation uses status `stopped-history-handoff-prepared` and
  prepared descriptor, with all other fields unchanged. Close explicitly
  closes scope and returns literal close; errors preserve evidence and exit 1.

### Task 3: Original-admission JS scope and saved dependencies

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff.mjs`
- Modify: `scripts/deployment/windows-stopped-history-handoff-record.mjs`
- Modify: `scripts/deployment/saved-worker-engine.mjs`

- [ ] Add the descriptor export using the existing identity/descriptor
  validators; retain 65536-byte limit for old archive descriptors, allowing
  1 MiB only for the prepared file.
- [ ] Export `openWindowsStoppedHistoryHandoffPreparation(options)`.
  Require canonical Windows paths, explicit update operation, distinct
  canonical nonzero attempt/previous/new-operation GUIDs, native Node identity
  and a structurally captured lock owner for token/project/createdAt.
  Require original retained admission before spawn and before/after every
  non-close request. Do not broaden deploy support while native derivation
  remains update-only.

  Verify exact native ready identity and exact observation fields against
  requested project, previous operation and attempt. Capture prepared
  descriptor through the new helper, with ready/prepared state consistency.
  A prepared observation must never revert or change its descriptor.

  Return immutable identity, observation getter, check, publish and close.
  Busy/closed/failed states are explicit. Reject repeated publish before
  sending a second mutation request, keeping the retained scope checkable.
  On protocol/admission/cancellation error abandon the exact transport,
  preserve diagnostic and make later close report failure. Close waits for
  clean native exit; do not swallow failure.

- [ ] Add only direct bridge dependency files to workerEngineFiles:
  new JS API/controller, prepared JS record, native owner, record,
  preparation and JSON comparator. Existing completion proof, archive and
  transport dependencies are already included. Existing saved-engine tests
  must enforce file inventory and bounded manifest.

- [ ] Commit/push; repeat focused and Contracts-only on the same SHA.
  Require all twelve actual history receipts, original production bridge
  death coverage and full Contracts success. Record actual job logs and
  commit/push acceptance.

## Self-review

No new generic request payload or larger shared frame is introduced. Fixed
startup scalar identity does not admit caller-provided task/state JSON. The
bridge holds archive handles and owner watcher until explicit close or death.
Preparation still grants no lock or state mutation authority. Same-attempt
controlled reopen and settled-attempt admission are not part of this bridge.
