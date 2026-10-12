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
