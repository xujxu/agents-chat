# Abandoned Handoff Publisher Death Implementation Plan

> **For agentic workers:** Execute inline as already selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove actual abandonment publisher death retains the exact terminal and prepared records and does not permit fresh actor lock authority.

**Architecture:** Extend the real history fixture with a sixth boundary. Kill the original preparation actor, then publish abandonment under a distinct actor and retained native scope. Kill that second actor, wait for its exact native bridge to exit, and let a third distinct actor verify retained descriptors and publication refusal before fixture-only cleanup.

**Tech Stack:** Existing Node/PowerShell real process death fixtures and Windows focused GitHub Actions.

---

### Task 1: Held terminal publication fixture

**Files:**
- Modify: `tests/deployment-windows-history-handoff-entry.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`

- [x] Permit `-Abandon -Hold`, retaining the existing controller watcher,
  archive scope and small descriptor-only ready frame. Continue refusing
  every command after readiness and require either Publish or Abandon for Hold.
- [x] Add `crash-abandoned-history` as a finalized-history resumer. Reuse the
  accepted original prepared observation and fresh-attempt refusal checks.
  Launch the existing native fixture through `windowsControllerTransport`
  with abandonment arguments and Hold. Check native ready PID/start identity
  and exact terminal filename, then emit:

```javascript
console.log(`INACTIVE_HISTORY_ABANDONED_HELD ${JSON.stringify({
  pid: ready.pid, processIdentity: ready.processIdentity,
  actorPid: process.pid, actorIdentity: await processIdentity(process.pid),
  attemptId: previous.attemptId, prepared: previous.prepared,
  terminal: ready.value, preparedActor: previous,
  completionSha256: previous.completionSha256,
})}`);
```

  Keep the actor alive without accepting commands until host termination.

### Task 2: Real second death and third actor

**Files:**
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [x] Add `abandoned-history` boundary using the existing actual preparation
  actor death first. Include it in all original archive/completion/prepared
  preservation assertions. Start `crash-abandoned-history` as the second
  actor; forward its existing PASS lines until its exact held marker.
- [x] Verify its native bridge identity, kill only that specific Node actor,
  wait for both actor and bridge to exit, and verify original terminal digest.
  Start `resume-abandoned-history` as the third actor using the held payload.
  Preserve current per-actor 120-second and bridge 15-second budgets.
- [x] Third actor checks original prepared and terminal bytes/hash/dev/ino,
  exact creator identity matching the now-dead second actor, absence of both
  old native identities, unchanged state and no lock. Invoke the real native
  abandonment publisher again with the same attempt and original descriptor:

```javascript
await assert.rejects(promisify(execFile)(pwsh, abandonArgs, {
  timeout: 45000, maxBuffer: 131072, windowsHide: true,
}), error => error.message.includes('Abandoned handoff publication failed; retain evidence.'));
```

  Require both files unchanged after refusal, then perform fixture-only exact
  terminal/prepared deletion and existing archive restore.
- [x] Add tenth required executed receipt:

```text
PASS: actual abandoned publisher death retains exact terminal evidence and a third actor cannot claim lock authority
```

### Task 3: Actions-only acceptance

- [x] Commit/push fixture coverage with required trailers and dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

- [x] Download actual job logs; require all ten executed receipts and the
  complete focused job green. Record SHA/run/job and push the evidence.

## Execution evidence

`8fcc39d5 / 40403014243`, actual stopped-history job `121853520355`,
succeeds. Downloaded execution logs contain all ten required actual receipts,
including the second publisher's real death and the third actor's exact
terminal preservation/refusal receipt. Both specific actors are killed and
their exact native bridges must exit before the next actor starts.

The third actor preserves original terminal/prepared bytes/hash/dev/ino,
original state and completion evidence, and no lock is created. Fixture-only
cleanup then restores the original archive for the remaining lifecycle test.
This accepts retained evidence and refusal, not native terminal reopening or
application lifecycle coverage.

## Self-review

This is death coverage for the accepted production publisher, not a fabricated
missing-implementation red. The third actor verifies evidence and real native
refusal; JS receipt inspection does not grant native terminal reopening or
lock authority. Production terminal receipt revalidation, settlement reuse
and create-only publication pending-file death remain separate later gates.
