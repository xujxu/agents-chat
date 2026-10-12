import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { writeWorkerFile } from '../scripts/deployment/worker-files.mjs';
import { captureWindowsColdRuntimeCompletion } from '../scripts/deployment/windows-cold-runtime-completion.mjs';
import * as completion from '../scripts/deployment/windows-cold-runtime-completion.mjs';
import { inspectWindowsColdRuntimeCompletion } from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import * as recovery from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { captureWindowsColdTerminalIntent } from '../scripts/deployment/windows-cold-terminal-intent.mjs';

test('cold terminal state publication requires acknowledgement and honors pre-abort', async () => {
  assert.equal(typeof recovery.publishWindowsColdTerminalState, 'function');
  await assert.rejects(recovery.publishWindowsColdTerminalState(), /data-loss acknowledgement/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recovery.publishWindowsColdTerminalState({
    acceptDataLoss: true, signal: controller.signal,
  }), { name: 'AbortError' });
});

test('cold terminal handoff requires explicit acknowledgement and honors pre-abort', async () => {
  assert.equal(typeof recovery.prepareWindowsColdTerminalRestore, 'function');
  await assert.rejects(recovery.prepareWindowsColdTerminalRestore(), /data-loss acknowledgement/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recovery.prepareWindowsColdTerminalRestore({
    acceptDataLoss: true, signal: controller.signal,
  }), { name: 'AbortError' });
});

test('cold released-prefix recovery requires acknowledgement and validates abort before admission', async () => {
  assert.equal(typeof recovery.prepareWindowsColdCompletionRecovery, 'function');
  await assert.rejects(recovery.prepareWindowsColdCompletionRecovery(), /data-loss acknowledgement/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recovery.prepareWindowsColdCompletionRecovery({
    acceptDataLoss: true, signal: controller.signal,
  }), { name: 'AbortError' });
  await assert.rejects(recovery.prepareWindowsColdCompletionRecovery({
    acceptDataLoss: true, control: 'relative', pwsh: 'relative',
  }), { code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_OBSERVATION_REFUSED', recoveryAllowed: false });
});

test('cold completed-runtime observation rejects abort and invalid paths before admission', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectWindowsColdRuntimeCompletion({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(inspectWindowsColdRuntimeCompletion({ control: 'relative', pwsh: 'relative' }),
    { code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_OBSERVATION_REFUSED', recoveryAllowed: false });
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const phases = ['prepared', 'policy-requested', 'policy-staged', 'release-requested', 'released',
  'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete'];
async function fixture(t) {
  const control = await temporaryDeployment(t);
  const directory = path.join(control, 'recovery-lock');
  await mkdir(directory, { mode: 0o700 });
  const intent = { operationId: '11111111-1111-4111-8111-111111111111', stateSha256: 'a'.repeat(64) };
  const intentBytes = Buffer.from(JSON.stringify(intent));
  const historyBytes = Buffer.from('original acknowledged running bytes\n');
  await writeWorkerFile(path.join(directory, 'activation-intent.json'), intentBytes);
  await writeWorkerFile(path.join(directory, 'activation-running.json'), historyBytes);
  const runtime = {
    pid: 33, identity: '33:1234', generation: '22222222-2222-4222-8222-222222222222',
    instanceGuid: '33333333-3333-4333-8333-333333333333', sessionId: 0,
    configurationSha256: 'b'.repeat(64), launcherPid: 34, readySha256: 'c'.repeat(64),
  };
  const running = {
    controllerPid: 22, controllerIdentity: '22:1234', runtime, taskName: 'fixture-task',
    configuration: 'C:\\control\\runtime\\configuration.json', definition: '<Task>guarded</Task>',
    securityDescriptor: 'original-security',
  };
  const options = { control, running, ownerSha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64),
    intentSha256: digest(intentBytes), port: 3010, providers: ['admin-login'] };
  const binding = {
    ...intent, ownerSha256: options.ownerSha256, filesReceiptSha256: options.receiptSha256,
    intentSha256: options.intentSha256, historySha256: digest(historyBytes),
    controllerPid: running.controllerPid, controllerIdentity: running.controllerIdentity,
    runtime, taskName: running.taskName, configuration: running.configuration,
    configurationSha256: runtime.configurationSha256, guardedDefinition: running.definition,
    stagedDefinition: '<Task>staged</Task>', permanentDefinition: '<Task>permanent</Task>',
    targetEnabled: true, securityDescriptor: running.securityDescriptor, port: options.port, providers: options.providers,
    listenerPid: 35, listenerIdentity: '35:1234', listenerAddress: '127.0.0.1',
    listenerCreatedAt: '1234', listenerPairedRecords: false,
  };
  let previousSha256 = binding.historySha256;
  for (const [index, phase] of phases.entries()) {
    const definition = index < 2 ? running.definition : index < 6 ? binding.stagedDefinition
      : index < 8 ? binding.permanentDefinition : '<Task>enabled</Task>';
    const bytes = Buffer.from(`${JSON.stringify({
      version: 1, ...binding, phase, previousSha256, definition,
      enabled: phase === 'complete', lease: index >= 4 ? 'released' : 'guarded',
    })}\n`);
    await writeWorkerFile(path.join(directory, `completion-${phase}.json`), bytes);
    previousSha256 = digest(bytes);
  }
  const value = {
    status: 'runtime-policy-restored', step: 'complete', lease: 'released',
    completionSha256: previousSha256, runtime, taskName: running.taskName, configuration: running.configuration,
    definition: '<Task>enabled</Task>', enabled: true, port: options.port, providers: options.providers,
  };
  return { ...options, value, directory };
}

test('cold completion prefix capture binds all nine finite durable boundaries', async t => {
  assert.equal(typeof completion.captureWindowsColdCompletionPrefix, 'function');
  const f = await fixture(t);
  for (const phase of phases) {
    const prefix = await completion.captureWindowsColdCompletionPrefix({ ...f, phase });
    assert.equal(prefix.record.phase, phase);
    assert.equal(prefix.sha256, digest(await readFile(path.join(f.directory, `completion-${phase}.json`))));
    assert.ok(Object.isFrozen(prefix));
    assert.ok(Object.isFrozen(prefix.record));
    assert.ok(Object.isFrozen(prefix.record.runtime));
  }
  await assert.rejects(completion.captureWindowsColdCompletionPrefix({ ...f, phase: 'policy-applied' }), /phase/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(completion.captureWindowsColdCompletionPrefix({
    ...f, phase: 'prepared', signal: controller.signal,
  }), { name: 'AbortError' });
  await assert.rejects(completion.captureWindowsColdCompletionPrefix({
    ...f, phase: 'policy-requested', ownerSha256: '0'.repeat(64),
  }), /binding/);
});

test('cold terminal intent preserves exact state transformation and original immutable evidence', async t => {
  const f = await fixture(t);
  const old = {
    version: 1, operationId: 'original-operation', project: f.control, operation: 'restore',
    phase: 'recovery-required', previousPhase: 'restoring', sourceCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40), backupId: 'original-backup', priorRuntime: 'running',
    runtimeIdentity: '44444444-4444-4444-8444-444444444444',
    startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:01:00.000Z', errorCode: 'fixture-crash',
  };
  const oldState = `${JSON.stringify(old)}\n`;
  const activationState = { ...old, phase: 'restore-activating', previousPhase: 'restoring', errorCode: null };
  const next = { ...activationState, phase: 'restored', previousPhase: 'restore-activating',
    updatedAt: '2026-10-01T00:02:00.000Z' };
  const observation = {
    operationId: old.operationId, taskName: f.running.taskName, stateSha256: digest(Buffer.from(oldState)),
    ownerSha256: f.ownerSha256, filesReceiptSha256: f.receiptSha256, intentSha256: f.intentSha256,
    historySha256: 'e'.repeat(64), completionSha256: f.value.completionSha256,
    runtime: f.running.runtime, port: f.port, providers: f.providers,
  };
  const descriptor = sha256 => ({ dev: '1', ino: '2', bytes: 100, sha256 });
  const expected = {
    project: f.control, observation, oldState, activationState,
    rootIdentity: { dev: '1', ino: '3' }, lockIdentity: { dev: '1', ino: '4' }, recoveryIdentity: { dev: '1', ino: '5' },
    files: { state: { ...descriptor(observation.stateSha256), bytes: Buffer.byteLength(oldState) }, lock: descriptor('c'.repeat(64)),
      transaction: descriptor('d'.repeat(64)) },
  };
  const value = {
    version: 1, phase: 'prepared', project: f.control, ...observation, oldState, nextState: JSON.stringify(next),
    rootIdentity: expected.rootIdentity, lockIdentity: expected.lockIdentity, recoveryIdentity: expected.recoveryIdentity,
    files: expected.files, creator: { pid: 90, processIdentity: '90:1234', bridgePid: 91, bridgeIdentity: '91:1234' },
  };
  const captured = captureWindowsColdTerminalIntent(value, expected);
  assert.deepEqual(captured, value);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.runtime) && Object.isFrozen(captured.creator));
  assert.ok(Object.isFrozen(captured.files) && Object.isFrozen(captured.files.state) && Object.isFrozen(captured.providers));
  for (const change of [
    { extra: true }, { phase: 'restored' }, { oldState: `${oldState}\n` }, { completionSha256: '0'.repeat(64) },
    { rootIdentity: { dev: '1', ino: '8' } }, { runtime: { ...value.runtime, pid: 999 } },
    { creator: { ...value.creator, bridgePid: 90, bridgeIdentity: '90:1234' } },
    { files: { ...value.files, transaction: { ...value.files.transaction, sha256: '0'.repeat(64) } } },
    ...[{ phase: 'accepted' }, { errorCode: 'foreign' }, { targetCommit: 'c'.repeat(40) },
      { updatedAt: old.startedAt }, { updatedAt: '2026-10-01T00:02:00Z' }, { extra: true }]
      .map(fields => ({ nextState: JSON.stringify({ ...next, ...fields }) })),
  ]) assert.throws(() => captureWindowsColdTerminalIntent({ ...value, ...change }, expected));
});

test('cold runtime completion binds every original receipt and returns immutable runtime-only progress', async t => {
  const f = await fixture(t);
  const result = await captureWindowsColdRuntimeCompletion(f);
  assert.deepEqual(result, f.value);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.runtime) && Object.isFrozen(result.providers));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureWindowsColdRuntimeCompletion({ ...f, signal: controller.signal }), { name: 'AbortError' });
});

test('cold runtime completion refuses changed policy, lease, identity, schema and original receipt bytes', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'completion-release-requested.json');
  const original = await readFile(file);
  const record = JSON.parse(original);
  for (const change of [
    { phase: 'released' }, { lease: 'released' }, { enabled: true }, { previousSha256: 'f'.repeat(64) },
    { definition: 'foreign policy' }, { controllerPid: 55 }, { historySha256: 'f'.repeat(64) },
    { targetEnabled: false }, { providers: ['github'] }, { listenerPid: 99 }, { extra: true },
  ]) {
    await writeFile(file, JSON.stringify({ ...record, ...change }));
    await assert.rejects(captureWindowsColdRuntimeCompletion(f));
  }
  await writeFile(file, Buffer.concat([original, Buffer.from('\n')]));
  await assert.rejects(captureWindowsColdRuntimeCompletion(f), /progression/);
  await writeFile(file, original);
  for (const change of [{ completionSha256: 'f'.repeat(64) }, { enabled: false }, { status: 'restored' }, { step: 'released' }]) {
    await assert.rejects(captureWindowsColdRuntimeCompletion({ ...f, value: { ...f.value, ...change } }));
  }
  await writeFile(file, Buffer.alloc(1048577, 32));
  await assert.rejects(captureWindowsColdRuntimeCompletion(f), /size/);
});

test('cold runtime completion accepts the exact native receipt limit with an original-byte chain', async t => {
  const f = await fixture(t);
  let previousSha256 = digest(await readFile(path.join(f.directory, 'activation-running.json')));
  for (const phase of phases) {
    const file = path.join(f.directory, `completion-${phase}.json`);
    const record = JSON.parse(await readFile(file));
    let bytes = Buffer.from(JSON.stringify({ ...record, previousSha256 }));
    if (phase === 'prepared') {
      bytes = Buffer.concat([bytes, Buffer.alloc(1048576 - bytes.length, 32)]);
      assert.equal(bytes.length, 1048576);
    }
    await writeFile(file, bytes);
    previousSha256 = digest(bytes);
  }
  const value = { ...f.value, completionSha256: previousSha256 };
  assert.deepEqual(await captureWindowsColdRuntimeCompletion({ ...f, value }), value);
});
