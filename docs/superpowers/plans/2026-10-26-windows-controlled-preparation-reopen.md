# Controlled Same-Owner Preparation Reopen Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reopen one exact prepared scope only for its original still-live owner under retained admission, without republishing evidence or granting lock authority.

**Architecture:** Add an explicit reopen API and native startup branch taking the exact prepared descriptor as scalars. Reuse the production bridge's native live-owner and complete binding check before readiness. Ordinary preparation remains empty-namespace-only; retired/fresh actors cannot reopen the old attempt, even if they know every original scalar.

**Tech Stack:** Existing retained native preparation controller, native private files, original Windows admission and focused actual actor death Actions.

---

### Task 1: Same-owner positive and foreign-owner refusal

**Files:**
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] After normal production publication and close, keep the existing
  ordinary-open refusal. Import new
  `reopenWindowsStoppedHistoryHandoffPreparation(options)` and call it with
  the exact original options plus `prepared: retainedDescriptor`.

  First reject changed token and incorrect prepared inode through the native
  bridge, requiring contextual refusal with diagnostic. Correct reopen must
  report prepared status and exact original descriptor immediately and after
  check. Repeat publish stays refused; close leaves original bytes/hash/dev/
  ino/state and no-lock assertions unchanged before fixture-only cleanup.

- [ ] In `resume-prepared-history` and the second abandonment actor, use
  every original attempt/owner scalar from the captured prepared record but
  the fresh current controller identity, then require reopen failure:

```javascript
await assert.rejects(reopenWindowsStoppedHistoryHandoffPreparation({
  ...options, project: prepared.project,
  previousOperationId: prepared.previousOperationId, operation: 'update',
  attemptId: prepared.attemptId, operationId: prepared.newOwner.operationId,
  token: prepared.newOwner.token, createdAt: prepared.newOwner.createdAt,
  prepared: previous.prepared,
}), error => error.code === 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED'
  && error.diagnostic?.includes('Prepared handoff JSON binding differs:'));
```

  Keep accepted native retired observation, terminal publication and both
  actual death boundaries unchanged. Fresh liveness and known token are not
  authority to impersonate the old owner.

- [ ] Add thirteenth actual receipt:

```text
PASS: controlled preparation reopen retains exact evidence for its original live owner and rejects a fresh actor
```

  Emit this receipt after positive reopen in the completed-history case;
  focused job must also complete both later fresh-actor refusal branches.

- [ ] Commit/push tests and dispatch focused history. Download actual logs;
  require a missing reopen export failure after accepted production publish,
  not an unrelated archived-state failure.

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

### Task 2: Explicit descriptor-bound native reopen

**Files:**
- Modify: `scripts/deployment/windows-stopped-history-handoff-controller.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff.mjs`

- [ ] Add scalar native startup parameters:

```powershell
[switch]$ReopenPrepared,
[string]$PreparedDev,
[string]$PreparedIno,
[int]$PreparedBytes,
[string]$PreparedSha256
```

  When explicitly selected, construct the exact prepared filename from
  canonical AttemptId, validate the descriptor and open through native
  retirement helper before initial observation. Reuse the production
  observation's exact one-file namespace, native original owner request and
  full typed JSON binding. No writes or alternate owner identity are accepted.
  Without ReopenPrepared, keep Descriptor/File null and require no existing
  handoff namespace.

- [ ] Keep two distinct exported JS entry points, internally sharing client
  lifecycle code. Ordinary open refuses a supplied prepared descriptor.
  Reopen requires a structurally captured exact prepared descriptor and
  supplies only its dev/ino/bytes/hash plus explicit native ReopenPrepared.
  Initial observation must match selected ready versus prepared mode, and
  reopened prepared descriptor must deep-equal the supplied exact descriptor.

  Keep startup operation/attempt/token/path/time validation, original
  admission checks, native controller identity, busy/failure behavior,
  monotonic descriptor checks and explicit close unchanged. The reopened
  client is already published; publish must remain refused before sending a
  mutation request, and native create-only publisher remains independently
  fail-closed.

- [ ] Commit/push and run focused history plus Windows Contracts-only on the
  same SHA. Require all thirteen executed receipts and both full jobs green.
- [ ] Record real red/green SHA/run/job evidence and push acceptance.

## Self-review

Reopen is not retrying publication and never replaces an existing record.
Exact old owner comparison comes from native current PID/start identity,
not the caller's claimed owner object. A dead original owner therefore cannot
be reopened by the next actor. Abandoned namespaces still fail the one-file
inventory; settlement/new-attempt admission remains separate.
