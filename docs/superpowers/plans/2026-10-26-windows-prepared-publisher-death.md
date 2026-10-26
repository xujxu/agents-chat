# Windows Prepared Publisher Death Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that actual preparation-actor death leaves exact prepared evidence without authorizing a distinct actor.

**Architecture:** Extend only the existing native test harness. Hold the already implemented publisher's original scope and owner watcher after publication; kill the actual Node actor, wait for its native bridge, then independently verify retained bytes/identity and refused republishing from a fresh actor.

**Tech Stack:** Existing native publisher, owner watcher, Windows controller transport, focused GitHub Actions fixture.

---

## Scope and files

This is coverage for the accepted production publisher, not a new production
bridge, permission or recovery API. No artificial missing-implementation red
phase is needed: production publication already exists and this increment
adds a real interruption scenario.

- Modify `tests/deployment-windows-history-handoff-entry.ps1`: `-Hold`
  fixture mode, valid only with `-Publish`.
- Modify `tests/deployment-windows-lost-runtime-session.mjs`: add
  `crash-prepared-history` and `resume-prepared-history`.
- Modify `tests/deployment-windows-inactive-task.ps1`: a fifth actual
  actor-death boundary, binding the published descriptor before resuming.
- Modify `.github/workflows/deployment-lifecycle.yml`: a seventh required
  exact PASS receipt.

## Task 1: Hold the real native publisher

- [x] Add `[switch]$Hold` to the fixture and refuse Hold without Publish.
  After publication, emit this small readiness frame and wait for input while
  retaining the original scope and watcher:

```powershell
if ($Hold) {
    [Console]::Out.WriteLine((@{
        type='ready'; pid=$PID; processIdentity=[Deployment.WindowsWorkerJob]::ProcessIdentity($PID)
        control=$Control; controllerIdentity=$ControllerIdentity; value=$record
    } | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
    $line = [Deployment.WindowsWorkerLauncher]::ReadFrameAsync([Console]::In, 4096)
    $null = $line.GetAwaiter().GetResult()
    throw 'Held preparation fixture does not accept commands.'
}
```

Normal fixture output remains the existing descriptor or derived record.
No shared wire/frame limits change.

## Task 2: Real Node actor death and fresh refusal

- [x] Include both new modes in the history branch. Treat the resumer as
  finalized history and retain its completion bytes/identity.
- [x] The new crashing mode first completes normal archive finalization and
  completion publication, closing those scopes. Start the held preparation
  fixture through `windowsControllerTransport`, with fresh attempt/operation/
  token GUIDs and the actual current actor identity:

```js
const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
const { captureWorkerFields } = await load('worker-identity.mjs');
const actorIdentity = await processIdentity(process.pid);
const attemptId = randomUUID();
const transport = windowsControllerTransport({
  pwsh, label: 'Held native preparation fixture',
  refused: cause => new Error('Held native preparation fixture failed.', { cause }),
  args: ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-history-handoff-entry.ps1', import.meta.url)),
    '-Source', source, '-Control', control,
    '-ControllerPid', String(process.pid), '-ControllerIdentity', actorIdentity,
    '-AttemptId', attemptId, '-OperationId', randomUUID(), '-Token', randomUUID(),
    '-CreatedAt', new Date().toISOString(), '-Publish', '-Hold'],
});
const ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
  ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held preparation');
assert.equal(ready.type, 'ready');
assert.equal(ready.pid, transport.child.pid);
assert.equal(ready.processIdentity, await processIdentity(ready.pid));
assert.equal(ready.control, control);
assert.equal(ready.controllerIdentity, actorIdentity);
assert.equal(ready.value.path, `inactive-handoff-${attemptId}-prepared.json`);
console.log(`INACTIVE_HISTORY_ARCHIVE_HELD ${JSON.stringify({
  pid: ready.pid, processIdentity: ready.processIdentity,
  actorIdentity, actorPid: process.pid, attemptId, prepared: ready.value,
  completionSha256: createHash('sha256').update(await readFile(completionFile)).digest('hex'),
})}`);
const timer = setInterval(() => {}, 1000);
try { await new Promise(() => {}); } finally { clearInterval(timer); }
```

On setup failure abandon the transport explicitly; never leave an unobserved
native fixture alive.

- [x] In the resumer bind the old prepared descriptor to its exact attempt
  name, read bytes and native identity, capture the accepted prepared schema,
  require its newOwner to be the dead original actor, and attempt fresh
  publication with a new GUID/current identity. Require explicit refusal,
  unchanged bytes/dev/ino and unchanged state, with no lock present. Only
  after these assertions may fixture cleanup unlink the exact prepared file.
  Emit:

```js
console.log('PASS: actual prepared publisher death retains its exact record and a distinct actor cannot claim lock authority');
```

## Task 3: Host bindings and Actions acceptance

- [x] Add `prepared-history` to the host's boundary list, mapping its
  crashing actor to `crash-prepared-history`. Include it in archived-intent
  and completed-receipt checks. Before starting its resumer, require its
  prepared descriptor path to match the exact attempt GUID and verify the
  native-published file digest. Preserve the existing specific actor kill,
  15-second bridge wait and 120-second resumer limits.
- [x] Require the new exact PASS receipt in the focused workflow, retaining
  every existing required receipt.
- [x] Commit/push with required session trailers and dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_application_only=true -f windows_live_only=true \
  -f windows_commands_only=true -f windows_restore_scenario=failed \
  -f windows_history_only=true
```

- [x] Watch at 180-second intervals and inspect actual job logs for all seven
  receipts. Diagnose failed identity/state/actor assertions before changing
  any budget. Record SHA/run/job evidence here and commit/push it.

## Execution evidence

`9a45a157 / 40377911324`, job `121765920982`, passes. Downloaded actual
job logs contain all seven required execution receipts, including real
preparation actor death, original bridge exit and a distinct actor's
explicit republishing refusal. Prepared bytes, digest, dev/ino and old
state remain exact before fixture-only cleanup; no new lock exists.
Existing four archive/completion/saved death receipts and both native
derivation/publication receipts remain present.

## Self-review and remaining scope

The new actor does not inherit the dead actor's prospective ownership.
Ordinary history verification may still prove the archived old operation;
it does not authorize a new lock. Existing evidence must not be replaced or
rewritten by the refusal path.

A production retained preparation bridge, explicit same-attempt reopening,
committed lock publication, state continuity and public routing remain gated.
This fixture proves actual publisher death only after complete publication;
pre-publication pending-file recovery needs its own coverage before transfer.
