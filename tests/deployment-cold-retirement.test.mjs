import assert from 'node:assert/strict';
import test from 'node:test';
import { workerEngineFiles } from '../scripts/deployment/saved-worker-engine.mjs';
import { windowsColdCompletionPhases } from '../scripts/deployment/windows-cold-runtime-completion.mjs';

function retirementRecord() {
  const hash = 'a'.repeat(64);
  const operationId = '11111111-1111-4111-8111-111111111111';
  let inode = 20;
  const file = path => ({ path, dev: '1', ino: String(inode++), bytes: 100, sha256: hash });
  const directory = path => ({ kind: 'directory', path, dev: '1', ino: String(inode++) });
  const files = (prefix, names) => names.map(name => ({ kind: 'file', ...file(`${prefix}\\${name}`) }));
  const entries = [
    ...files('task-maintenance', ['admission.json', 'transaction.json', 'task-stop-intent.json',
      'task-stop-inhibited.json', 'task-stop-stop-requested.json', 'task-stop-stopped.json']),
    directory('task-maintenance'),
    ...files('recovery-lock', ['owner.json', 'files-restored.json', 'activation-intent.json',
      'activation-start-requested.json', 'activation-running.json',
      ...windowsColdCompletionPhases.map(phase => `completion-${phase}.json`)].sort()),
    directory('recovery-lock'), ...files('worker-engine', [...workerEngineFiles, 'manifest.json']),
    directory('worker-engine'), { kind: 'file', ...file('worker-operation.ndjson') },
    { kind: 'file', ...file('cold-restore-terminal.json') }, { kind: 'file', ...file('lock\\owner.json') },
    directory('lock'),
  ];
  const { kind, ...terminal } = entries.find(entry => entry.path === 'cold-restore-terminal.json');
  const pair = pid => ({ pid, processIdentity: `${pid}:${pid}0` });
  return {
    version: 5, purpose: 'cold-restore', control: 'C:\\private\\ctl', project: 'C:\\private\\project',
    lock: { version: 1, token: operationId, project: 'C:\\private\\project', operationId,
      ...pair(10), createdAt: '2026-10-13T02:00:00.000Z' },
    controlIdentity: { dev: '1', ino: '1' }, state: file('state.json'), receipt: file('deployment.json'), terminal,
    completion: {
      status: 'observed', mutationAuthority: false, operationId, taskName: 'Cold-Retirement-Fixture',
      stateSha256: hash, completionSha256: hash, port: 3010, providers: ['admin-login'], lease: 'released',
      runtime: { pid: 70, identity: '70:700', generation: operationId, instanceGuid: operationId,
        sessionId: 0, configurationSha256: hash, launcherPid: 71, readySha256: hash },
    },
    checkpoint: {
      configuration: `C:\\private\\ctl\\runtime-${operationId}\\configuration.json`,
      definitionSha256: hash, securityDescriptorSha256: hash, enabled: true,
      listener: { pid: 72, processIdentity: '72:720', address: '127.0.0.1', createdAt: '1', pairedRecords: false },
    },
    originals: { restoreController: pair(10), stoppedRuntime: pair(11), coldController: pair(12), activationBridge: pair(13) },
    workerManifestSha256: hash, entries,
    creator: { ...pair(90), bridgePid: 91, bridgeIdentity: '91:910' },
  };
}

test('cold retirement requires explicit acknowledgement and honors cancellation before admission', async () => {
  const { retireWindowsColdRestoredDeployment } =
    await import('../scripts/deployment/windows-cold-deployment-retirement.mjs');
  assert.equal(typeof retireWindowsColdRestoredDeployment, 'function');
  await assert.rejects(retireWindowsColdRestoredDeployment(), /data-loss acknowledgement/);
  await assert.rejects(retireWindowsColdRestoredDeployment({
    acceptDataLoss: true, onProgress: 42,
  }), /progress callback/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(retireWindowsColdRestoredDeployment({
    acceptDataLoss: true, signal: controller.signal,
  }), { name: 'AbortError' });
});

test('cold retirement record freezes its ordered scope and preserves original disabled policy', {
  skip: process.platform !== 'win32',
}, async () => {
  const { captureWindowsColdRetirementRecord } = await import('../scripts/deployment/windows-cold-retirement-record.mjs');
  const value = retirementRecord();
  const record = captureWindowsColdRetirementRecord(value);
  assert.deepEqual(record, value);
  for (const object of [record, record.entries, ...record.entries, record.lock, record.originals,
    record.completion, record.completion.runtime, record.checkpoint, record.checkpoint.listener]) {
    assert.ok(Object.isFrozen(object));
  }
  assert.deepEqual(record.entries.slice(-2).map(entry => entry.path), ['lock\\owner.json', 'lock']);
  assert.equal(record.entries.some(entry => /backup|^runtime-|^state\.json$|^deployment\.json$/.test(entry.path)), false);
  value.checkpoint.enabled = false;
  assert.equal(captureWindowsColdRetirementRecord(value).checkpoint.enabled, false);
  value.entries.find(entry => entry.path === 'recovery-lock\\activation-running.json').bytes = 4194304;
  captureWindowsColdRetirementRecord(value);
  const { captureRetirementFile } = await import('../scripts/deployment/windows-task-retirement-record.mjs');
  assert.throws(() => captureRetirementFile({ ...value.state, bytes: 1048577 }, 'state.json'));
});

test('cold retirement record refuses unsafe scope, identity substitution and reordered deletion', {
  skip: process.platform !== 'win32',
}, async () => {
  const { captureWindowsColdRetirementRecord } = await import('../scripts/deployment/windows-cold-retirement-record.mjs');
  const mutations = [
    value => { value.version = 4; },
    value => { value.extra = true; },
    value => { value.control = value.project; },
    value => { value.project = `${value.control}\\app`; value.lock.project = value.project; },
    value => { value.entries[0].path = '..\\backup'; },
    value => { value.entries[1].ino = value.entries[0].ino; },
    value => { value.entries.reverse(); },
    value => { value.entries.pop(); },
    value => { value.state.ino = value.entries[0].ino; },
    value => { value.receipt.ino = value.state.ino; },
    value => { value.entries[0].bytes = 1048577; },
    value => { value.entries.find(entry => entry.path === 'recovery-lock\\activation-running.json').bytes = 4194305; },
    value => { value.completion.stateSha256 = 'b'.repeat(64); },
    value => { value.completion.completionSha256 = 'b'.repeat(64); },
    value => { value.terminal.sha256 = 'b'.repeat(64); },
    value => { value.originals.restoreController = value.originals.stoppedRuntime; },
    value => { value.originals.stoppedRuntime = { pid: 70, processIdentity: '70:700' }; },
    value => { value.checkpoint.configuration = 'C:\\foreign\\configuration.json'; },
    value => { value.checkpoint.enabled = 'false'; },
    value => { value.completion.lease = 'guarded'; },
  ];
  for (const mutate of mutations) {
    const value = retirementRecord();
    mutate(value);
    assert.throws(() => captureWindowsColdRetirementRecord(value));
  }
});
