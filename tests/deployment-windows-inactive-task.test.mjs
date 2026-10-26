import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

const project = path.resolve('inactive-project');
const taskName = 'Agents-Chat-Inactive-Test';
const configurationSha256 = 'a'.repeat(64);
const retiredRuntime = {
  pid: 1234, identity: '1234:638900000000000000',
  generation: '11111111-1111-4111-8111-111111111111',
  sessionId: 1, configurationSha256, launcherPid: 1235, readySha256: 'b'.repeat(64),
};
const observation = () => ({
  status: 'inactive-task-observed', runtimeAuthority: false,
  project, taskName, definition: '<Task/>', securityDescriptor: 'D:P(A;;FA;;;SY)',
  principalSid: 'S-1-5-18', enabled: false,
  configuration: path.resolve('inactive-bundle', 'configuration.json'),
  configurationSha256, runtime: null, retiredRuntime: { ...retiredRuntime },
});
const capture = async () => (await import('../scripts/deployment/windows-managed-task-observation.mjs'))
  .captureWindowsInactiveTaskObservation;

test('inactive Windows observation preserves a retired identity without inventing a current runtime', async () => {
  const read = await capture();
  const input = observation();
  const value = read(input, project, taskName);
  assert.deepEqual(value, input);
  assert.equal(value.runtime, null);
  assert.equal(value.runtimeAuthority, false);
  assert.equal(Object.hasOwn(value.retiredRuntime, 'instanceGuid'), false);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.retiredRuntime));
  input.retiredRuntime.pid = 9999;
  assert.equal(value.retiredRuntime.pid, 1234);
});

test('inactive Windows observation refuses enabled policy, current authority and incomplete retired evidence', async () => {
  const read = await capture();
  for (const patch of [
    { enabled: true }, { enabled: 'false' }, { runtime: retiredRuntime },
    { runtimeAuthority: true }, { retiredRuntime: null }, { retiredRuntime: {} },
    { status: 'managed-task-observed' }, { lease: 'released' },
    { project: `${project}-foreign` }, { taskName: `${taskName}-foreign` },
    { configurationSha256: 'c'.repeat(64) }, { definition: '' },
    { securityDescriptor: '' }, { principalSid: 'SYSTEM' },
    { configuration: path.resolve('inactive-bundle', 'other.json') },
  ]) {
    assert.throws(() => read({ ...observation(), ...patch }, project, taskName));
  }
});

test('inactive Windows observation rejects malformed retired identities rather than treating them as absence', async () => {
  const read = await capture();
  for (const patch of [
    { pid: 0 }, { identity: '9999:638900000000000000' }, { generation: 'unknown' },
    { instanceGuid: null }, { sessionId: -1 }, { launcherPid: 0 },
    { readySha256: '' }, { configurationSha256: 'c'.repeat(64) },
    { extra: true },
  ]) {
    const input = observation();
    input.retiredRuntime = { ...input.retiredRuntime, ...patch };
    assert.throws(() => read(input, project, taskName));
  }
});

const admissionInput = () => {
  const createdAt = '2026-10-16T00:00:00.000Z';
  const operationId = '33333333-3333-4333-8333-333333333333';
  return {
    observation: observation(),
    lock: {
      version: 1, token: '44444444-4444-4444-8444-444444444444',
      operationId, project, pid: 4321, processIdentity: '4321:638900000000000001', createdAt,
    },
    state: {
      version: 1, operationId, project, operation: 'update', phase: 'preflight', previousPhase: null,
      sourceCommit: null, targetCommit: null, backupId: null,
      priorRuntime: 'stopped', runtimeIdentity: retiredRuntime.generation,
      startedAt: createdAt, updatedAt: createdAt, errorCode: null,
    },
  };
};
const admissionBuilder = async () => (await import('../scripts/deployment/windows-inactive-task-admission.mjs'))
  .createWindowsInactiveTaskAdmissionRecord;

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

test('inactive admission record binds stopped preflight and its actual lock without a current task instance', async () => {
  const build = await admissionBuilder();
  const input = admissionInput();
  const value = build(input);
  assert.equal(value.version, 2);
  assert.equal(value.kind, 'inactive');
  assert.equal(value.operationId, input.lock.operationId);
  assert.equal(value.controllerPid, input.lock.pid);
  assert.equal(value.controllerIdentity, input.lock.processIdentity);
  assert.deepEqual(value.retiredRuntime, input.observation.retiredRuntime);
  assert.equal(Object.hasOwn(value, 'instanceGuid'), false);
  assert.equal(Object.hasOwn(value, 'ownerPid'), false);
  assert.ok(Object.isFrozen(value));
  input.observation.retiredRuntime.pid = 9999;
  assert.equal(value.retiredRuntime.pid, 1234);
});

test('inactive admission refuses running state, a foreign lock and later phases before native publication', async () => {
  const build = await admissionBuilder();
  for (const patch of [
    { priorRuntime: 'running' }, { priorRuntime: 'absent' }, { phase: 'stopped' },
    { previousPhase: 'preflight' }, { runtimeIdentity: 'foreign' }, { project: `${project}-foreign` },
    { operationId: '55555555-5555-4555-8555-555555555555' },
    { startedAt: '2026-10-15T00:00:00.000Z' }, { errorCode: 'FAILED' },
    { operation: 'restore', phase: 'restore-preflight' },
  ]) {
    const input = admissionInput();
    input.state = { ...input.state, ...patch };
    assert.throws(() => build(input));
  }
  const input = admissionInput();
  input.lock.project = `${project}-foreign`;
  assert.throws(() => build(input));
});
