import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { writeWorkerFile } from '../scripts/deployment/worker-files.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['receipt-staged', 'receipt-published', 'complete'].includes(target));
assert.equal(process.env.PATH, undefined, 'Receipt authority must work in the public saved-entry environment.');
const snapshot = await verifySnapshot(path.join(control, 'backup'));
const saved = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
const { openWindowsColdReceiptAuthority } = await import(pathToFileURL(
  path.join(saved.directory, 'windows-cold-activation-recovery.mjs')));
const { publishWindowsColdRestoredDeploymentReceipt, publishRestoredDeploymentReceipt, readDeploymentReceipt } =
  await import(pathToFileURL(path.join(saved.directory, 'deployment-receipt.mjs')));
const marker = JSON.parse(await readFile(path.join(control, 'cold-restore-terminal.json')));
const state = JSON.parse(marker.nextState);
// Synthetic fingerprints exercise only the writer; the retained runtime proof is genuine.
const identity = Object.freeze({
  source: state.targetCommit, build: 'b'.repeat(64), dependencies: 'c'.repeat(64),
  config: 'd'.repeat(64), service: 'e'.repeat(64),
});
const destination = path.join(control, 'deployment.json');
const stage = path.join(control, '.deployment.json.staging');
if (target === 'receipt-staged' && await readDeploymentReceipt(control, marker.project) === null) {
  await writeWorkerFile(destination, Buffer.from(`${JSON.stringify({
    version: 1, project: marker.project, operationId: 'prior-receipt-fixture',
    status: 'accepted', acceptedAt: '2026-01-01T00:00:00.000Z', identity,
  })}\n`));
}
const beforeReceipt = await readFile(destination);
if (target !== 'complete') assert.notEqual(JSON.parse(beforeReceipt).operationId, marker.operationId);
const beforeInfo = await lstat(destination, { bigint: true });
const names = (await readdir(path.join(control, 'recovery-lock'))).sort();
const originals = new Map(await Promise.all([
  'state.json', 'cold-restore-terminal.json', 'lock/owner.json',
  'task-maintenance/transaction.json', 'backup/manifest.json',
  ...names.map(name => `recovery-lock/${name}`),
].map(async name => [name, await readFile(path.join(control, name))])));
const stagedBefore = target === 'receipt-published'
  ? { bytes: await readFile(stage), info: await lstat(stage, { bigint: true }) } : null;
for (const changed of [
  { ...snapshot, id: `${snapshot.id}-foreign` },
  { ...snapshot, source: { ...snapshot.source, commit: 'f'.repeat(40) } },
  { ...snapshot, recoveryEngine: 'f'.repeat(64) },
  { ...snapshot, runtime: { ...snapshot.runtime, task: { ...snapshot.runtime.task, name: 'Foreign-Receipt-Task' } } },
  { ...snapshot, entries: [] },
]) {
  await assert.rejects(openWindowsColdReceiptAuthority({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: changed,
  }), /differs from the verified saved restore snapshot/);
  assert.deepEqual(await readFile(destination), beforeReceipt);
  for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(control, name)), bytes);
  if (stagedBefore) {
    assert.deepEqual(await readFile(stage), stagedBefore.bytes);
    const info = await lstat(stage, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(info[key], stagedBefore.info[key]);
  }
}
const authority = await openWindowsColdReceiptAuthority({
  control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot,
});
let result;
try {
  assert.ok(Object.isFrozen(authority) && Object.isFrozen(authority.state) && Object.isFrozen(authority.lock));
  assert.deepEqual(authority.state, state);
  for (const name of ['advance', 'prepareTerminal', 'stageTerminalState', 'publishTerminalState']) {
    assert.equal(authority[name], undefined);
  }
  const options = { control, authority, lock: authority.lock, identity };
  let invalidCallbacks = 0;
  const forbiddenCheck = async () => { invalidCallbacks++; return identity; };
  for (const changed of [
    { authority: Object.freeze({ ...authority }) },
    { control: path.join(control, 'foreign-control') },
    { lock: { ...authority.lock, operationId: 'foreign-operation' } },
  ]) {
    await assert.rejects(publishWindowsColdRestoredDeploymentReceipt({
      ...options, ...changed, checkAccepted: forbiddenCheck,
    }), /original cold terminal authority/i);
  }
  await assert.rejects(publishRestoredDeploymentReceipt({
    ...options, checkAccepted: forbiddenCheck,
  }), /current lock owner/);
  await assert.rejects(publishWindowsColdRestoredDeploymentReceipt({
    ...options, checkAccepted: forbiddenCheck, onProgress: 42,
  }), /progress callback/);
  assert.equal(invalidCallbacks, 0);
  let checks = 0;
  const checkAccepted = async () => {
    checks++;
    await assert.rejects(readFile(path.join(control, 'task-maintenance/transaction.json')), { code: 'EBUSY' });
    return identity;
  };
  const progressSteps = [];
  const onProgress = async progress => {
    assert.ok(Object.isFrozen(progress));
    assert.equal(progress.operationId, marker.operationId);
    assert.ok(checks > 0);
    progressSteps.push(progress.step);
    if (progress.step !== target) return;
    const current = await readDeploymentReceipt(control, marker.project);
    let staged = null;
    try { staged = JSON.parse(await readFile(stage)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receipt = target === 'receipt-staged' ? staged : current;
    assert.equal(receipt.operationId, marker.operationId);
    assert.equal(receipt.acceptedAt, state.updatedAt);
    assert.deepEqual(receipt.identity, identity);
    if (target === 'receipt-staged') assert.deepEqual(await readFile(destination), beforeReceipt);
    else assert.equal(staged, null);
    process.stdout.write(`${JSON.stringify({ progress: {
      ...progress, identity: authority.identity,
    } })}\n`);
    await new Promise(() => {});
  };
  result = await publishWindowsColdRestoredDeploymentReceipt({ ...options, checkAccepted, onProgress });
  assert.equal(target, 'complete', 'Receipt interruption boundary was skipped.');
  assert.deepEqual(await publishWindowsColdRestoredDeploymentReceipt({ ...options, checkAccepted, onProgress }), result);
  assert.deepEqual(progressSteps, ['receipt-published', 'receipt-published']);
  const changed = { ...identity, service: 'f'.repeat(64) };
  await assert.rejects(publishWindowsColdRestoredDeploymentReceipt({
    ...options, identity: changed, checkAccepted: async () => changed,
  }), /original operation identity/);
  await assert.rejects(lstat(stage), { code: 'ENOENT' });
  assert.deepEqual(await readFile(destination), beforeReceipt);
  const after = await lstat(destination, { bigint: true });
  for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], beforeInfo[key]);
} finally {
  await authority.close();
}
await assert.rejects(publishWindowsColdRestoredDeploymentReceipt({
  control, authority, lock: authority.lock, identity,
  checkAccepted: async () => { assert.fail('Closed authority reached acceptance.'); },
}), /original cold terminal authority/i);
assert.deepEqual((await readdir(path.join(control, 'recovery-lock'))).sort(), names);
for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(control, name)), bytes);
process.stdout.write(`${JSON.stringify({ result })}\n`);
