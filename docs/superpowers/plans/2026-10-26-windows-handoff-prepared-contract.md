# Windows Handoff Prepared Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the bounded immutable prepared-record contract without publishing files, creating locks or granting authority.

**Architecture:** A pure capture helper reuses lock, state and inactive observation validators. It binds exact prior state bytes and original archive descriptors to a distinct requested owner; native verification remains mandatory and is not simulated by this helper.

**Tech Stack:** Node.js ESM, node:crypto, node:test, existing Actions Windows Contracts.

---

## Scope and file map

Prerequisite: namespace fence `73ba5b74`, accepted by `40335404387`.
Design: `docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md`.
The user selected continued inline execution.

- Create `scripts/deployment/windows-stopped-history-handoff-record.mjs`:
  prepared-record structural capture only, with no I/O or admission API.
- Modify `tests/deployment-windows-inactive-task.test.mjs`: reuse the existing
  project, observation and admission-input fixtures.
- Modify `.github/workflows/deployment-lifecycle.yml`: add that test file
  to the explicit private Windows Contracts list. Its existing inclusion
  in native command contracts does not cover the Contracts-only selector.
- Modify this plan with actual Actions red/green evidence.

The helper accepts an already decoded object. It is not a JSON parser or a
native proof. Future native publication must independently parse exact
fields, pin descriptors, verify actual actor identities, task policy and
archive completeness, and reject duplicate JSON fields.

## Task 1: Add failing prepared-record contracts

- [ ] Add the crypto import to the existing test file:

```js
import { createHash } from 'node:crypto';
```

- [ ] Append these fixtures and behavioral tests:

```js
const handoffInput = () => {
  const prior = admissionInput();
  const oldState = JSON.stringify({
    ...prior.state, phase: 'restored', previousPhase: 'accepted',
    sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), backupId: 'original-backup',
  });
  const descriptor = (name, bytes = 1, sha256 = 'c'.repeat(64)) => ({
    path: name, dev: '1', ino: '2', bytes, sha256,
  });
  return {
    version: 1, phase: 'stopped-history-handoff-prepared',
    attemptId: '66666666-6666-4666-8666-666666666666',
    control: path.resolve('inactive-control'), project,
    controlIdentity: { dev: '1', ino: '3' },
    previousOperationId: prior.state.operationId, operation: 'update',
    oldState,
    state: descriptor('state.json', Buffer.byteLength(oldState),
      createHash('sha256').update(oldState).digest('hex')),
    intent: descriptor(`retired-${prior.state.operationId}-inactive-rollback-history-intent.json`),
    completion: descriptor(`retired-${prior.state.operationId}-inactive-rollback-history-complete.json`),
    newOwner: { ...prior.lock, operationId: '55555555-5555-4555-8555-555555555555' },
    observation: observation(),
  };
};
const handoffCapture = async () =>
  (await import('../scripts/deployment/windows-stopped-history-handoff-record.mjs'))
    .captureWindowsStoppedHistoryHandoffPrepared;

test('prepared history handoff binds exact prior bytes and detached inactive owner request', async () => {
  const capture = await handoffCapture();
  const input = handoffInput();
  const record = capture(input);
  assert.deepEqual(record, input);
  for (const value of [record, record.controlIdentity, record.state, record.intent,
    record.completion, record.newOwner, record.observation, record.observation.retiredRuntime]) {
    assert.ok(Object.isFrozen(value));
  }
  input.newOwner.pid = 99;
  input.state.sha256 = '0'.repeat(64);
  input.observation.retiredRuntime.pid = 99;
  assert.equal(record.newOwner.pid, 4321);
  assert.notEqual(record.state.sha256, input.state.sha256);
  assert.equal(record.observation.retiredRuntime.pid, 1234);
});

test('prepared history handoff rejects foreign, incomplete and inconsistent requests', async () => {
  const capture = await handoffCapture();
  const original = handoffInput();
  const changedState = patch => {
    const oldState = JSON.stringify({ ...JSON.parse(original.oldState), ...patch });
    return { oldState, state: { ...original.state, bytes: Buffer.byteLength(oldState),
      sha256: createHash('sha256').update(oldState).digest('hex') } };
  };
  for (const patch of [
    { extra: true }, { version: 2 }, { phase: 'stopped-history-handoff-committed' },
    { attemptId: original.previousOperationId }, { control: 'relative' },
    { previousOperationId: original.newOwner.operationId }, { operation: 'restore' },
    { controlIdentity: { dev: '4294967296', ino: '3' } },
    { controlIdentity: { dev: '1', ino: '18446744073709551616' } },
    { state: { ...original.state, sha256: '0'.repeat(64) } },
    { intent: { ...original.intent, path: 'inactive-rollback-history-intent.json' } },
    { completion: { ...original.completion, bytes: 65537 } },
    { newOwner: { ...original.newOwner, processIdentity: '9999:638900000000000001' } },
    { newOwner: { ...original.newOwner, project: `${project}-foreign` } },
    { observation: { ...original.observation, enabled: true } },
    changedState({ project: `${project}-foreign` }),
    changedState({ phase: 'accepted' }),
    changedState({ runtimeIdentity: 'unbound-generation' }),
    changedState({ errorCode: 'FAILED' }),
  ]) assert.throws(() => capture({ ...handoffInput(), ...patch }));
});
```

- [ ] Commit and push the test-only change with required session trailers.
  Dispatch Windows Contracts:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Watch the returned run ID at 180-second intervals and inspect failed
  logs. Expected: the two new tests fail because the requested module is
  missing. Do not execute Node or the test harness locally.

## Task 2: Implement structural capture, without authority

- [ ] Create the module with the following complete implementation:

```js
import { createHash } from 'node:crypto';
import path from 'node:path';
import { captureLockOwner, validateState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureWindowsInactiveTaskObservation } from './windows-managed-task-observation.mjs';

const guid = value => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

function captureIdentity(input) {
  const value = captureWorkerFields(input, ['dev', 'ino'], 'handoff identity');
  if (typeof value.dev !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value.dev)
    || typeof value.ino !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.ino)
    || BigInt(value.dev) > 4294967295n || BigInt(value.ino) > 18446744073709551615n) {
    throw new Error('Invalid stopped history handoff identity.');
  }
  return value;
}

function captureDescriptor(input, name) {
  const value = captureWorkerFields(input, ['path', 'dev', 'ino', 'bytes', 'sha256'],
    'handoff descriptor');
  captureIdentity({ dev: value.dev, ino: value.ino });
  if (value.path !== name || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > 65536
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Invalid stopped history handoff descriptor.');
  }
  return value;
}

export function captureWindowsStoppedHistoryHandoffPrepared(input) {
  const record = captureWorkerFields(input, [
    'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
    'previousOperationId', 'operation', 'oldState', 'state', 'intent',
    'completion', 'newOwner', 'observation',
  ], 'prepared history handoff');
  if (record.version !== 1 || record.phase !== 'stopped-history-handoff-prepared'
    || !guid(record.attemptId) || !guid(record.previousOperationId)
    || !canonical(record.control) || !canonical(record.project)
    || !['deploy', 'update'].includes(record.operation)
    || typeof record.oldState !== 'string' || Buffer.byteLength(record.oldState) > 65536) {
    throw new Error('Invalid prepared stopped history handoff.');
  }
  const controlIdentity = captureIdentity(record.controlIdentity);
  const state = captureDescriptor(record.state, 'state.json');
  const intent = captureDescriptor(record.intent,
    `retired-${record.previousOperationId}-inactive-rollback-history-intent.json`);
  const completion = captureDescriptor(record.completion,
    `retired-${record.previousOperationId}-inactive-rollback-history-complete.json`);
  const prior = validateState(JSON.parse(record.oldState));
  const newOwner = captureLockOwner(record.newOwner);
  const observation = captureWindowsInactiveTaskObservation(record.observation,
    record.project, record.observation?.taskName);
  if (state.bytes !== Buffer.byteLength(record.oldState)
    || state.sha256 !== createHash('sha256').update(record.oldState).digest('hex')
    || prior.project !== record.project || prior.operationId !== record.previousOperationId
    || prior.operation !== 'update' || prior.phase !== 'restored'
    || prior.previousPhase !== 'accepted' || prior.priorRuntime !== 'stopped'
    || prior.errorCode !== null || prior.sourceCommit === null || prior.targetCommit === null
    || prior.backupId === null || prior.runtimeIdentity !== observation.retiredRuntime.generation
    || newOwner.project !== record.project || !guid(newOwner.operationId)
    || new Set([record.attemptId, record.previousOperationId, newOwner.operationId]).size !== 3
    || !new RegExp(`^${newOwner.pid}:[1-9][0-9]*$`).test(newOwner.processIdentity)
    || Date.parse(newOwner.createdAt) < Date.parse(prior.updatedAt)) {
    throw new Error('Stopped history handoff differs from its original evidence.');
  }
  return Object.freeze({ ...record, controlIdentity, state, intent, completion, newOwner, observation });
}
```

- [ ] Commit and push the module with required session trailers. Dispatch
  Windows Contracts with the exact command from Task 1, watch at 180-second
  intervals and inspect the actual two test results. Expected: both pass,
  existing inactive and lock-admission contracts remain green.
- [ ] Record red and green SHAs/run IDs/job IDs here and commit the evidence.

## Execution evidence

`57938b0e / 40338806633`, job `121634671099`, unexpectedly succeeds.
Downloaded logs contain neither new prepared-handoff test. Inspection of
the workflow confirms the test file is absent from the explicit Windows
Contracts list, despite its inclusion in native command validation.
This is not red-phase acceptance. Add it to the actual Contracts list and
repeat the test-only red phase before publishing the implementation.

## Self-review and remaining gates

Only the prepared schema is stabilized here. No committed-record schema is
invented before native lock publication has established its descriptors.
All nested mutable input fields are independently captured. Native identity
number bounds match `Assert-AgentsChatRetirementIdentity`; descriptor names
are derived from the exact original operation, not supplied paths.

This helper cannot prove process liveness, descriptor existence or task
settlement, and is not connected to any authority-bearing entry point.
The subsequent native publication plan must add those checks and real
death/replacement tests. State continuity, dead-owner cleanup, explicit
release/reconciliation and public inactive routing remain gated as specified
in the approved design.
