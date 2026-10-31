import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { windowsTaskCompletionSteps } from '../scripts/deployment/windows-task-controller.mjs';

const [control, pwshArgument, target] = process.argv.slice(2);
const pwsh = realpathSync.native(pwshArgument);
assert.ok(['permanent-policy-applied', 'enable-applied', 'complete'].includes(target));
assert.equal(process.env.PATH, undefined);
const snapshot = await verifySnapshot(path.join(control, 'backup'));
const saved = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
const { prepareWindowsColdCompletionRecovery } = await import(
  pathToFileURL(path.join(saved.directory, 'windows-cold-activation-recovery.mjs')));
const journal = path.join(control, 'recovery-lock');
const names = (await readdir(journal)).sort();
const originals = new Map(await Promise.all([
  'state.json', 'lock/owner.json', 'task-maintenance/transaction.json', 'backup/manifest.json',
  ...names.map(name => `recovery-lock/${name}`),
].map(async name => {
  const file = path.join(control, name);
  return [name, { bytes: await readFile(file), info: await lstat(file, { bigint: true }) }];
})));
for (const changed of [
  { ...snapshot, id: `${snapshot.id}-foreign` },
  { ...snapshot, source: { ...snapshot.source, commit: 'f'.repeat(40) } },
  { ...snapshot, recoveryEngine: 'f'.repeat(64) },
  { ...snapshot, runtime: { ...snapshot.runtime, task: { ...snapshot.runtime.task, name: 'Foreign-Completion-Task' } } },
  { ...snapshot, entries: [] },
]) {
  await assert.rejects(prepareWindowsColdCompletionRecovery({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: changed,
  }), /differs from the verified saved restore snapshot/);
  for (const [name, before] of originals) {
    const file = path.join(control, name);
    assert.deepEqual(await readFile(file), before.bytes);
    const after = await lstat(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
  }
  assert.deepEqual((await readdir(journal)).sort(), names);
  for (const name of ['cold-restore-terminal.json', 'state.json.lock', '.deployment.json.staging', 'worker-retirement.json']) {
    await assert.rejects(lstat(path.join(control, name)), { code: 'ENOENT' });
  }
}
const steps = windowsTaskCompletionSteps.filter(step => step !== 'lease-released');
const recovery = await prepareWindowsColdCompletionRecovery({ control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot });
let progress = recovery.observation;
const initial = progress;
try {
  assert.equal(progress.status, 'cold-completion-recovery');
  assert.equal(progress.mutationAuthority, true);
  assert.equal(progress.lease, 'released');
  assert.equal(recovery.archive, undefined);
  assert.ok(Object.isFrozen(recovery.identity));
  assert.equal(initial.step, {
    'permanent-policy-applied': 'release-requested', 'enable-applied': 'permanent-policy-applied', complete: 'enable-applied',
  }[target]);
  await assert.rejects(recovery.prepareTerminal(), /completed runtime policy/);
  const transaction = path.join(control, 'task-maintenance/transaction.json');
  await assert.rejects(readFile(transaction), error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recovery.advance({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await recovery.check(), progress);
  let count = 0;
  while (progress.step !== target) {
    assert.ok(count++ < 9, 'Cold recovery skipped its interruption boundary.');
    const previous = progress;
    progress = await recovery.advance();
    assert.equal(progress.step, steps[steps.indexOf(previous.step) + 1]);
    assert.deepEqual(progress.runtime, initial.runtime);
    assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.runtime) && Object.isFrozen(progress.providers));
    assert.deepEqual(await recovery.check(), progress);
  }
  const receipt = path.join(control, 'recovery-lock', `completion-${progress.phase}.json`);
  const bytes = await readFile(receipt);
  await assert.rejects(writeFile(receipt, bytes));
  if (target !== 'complete') {
    console.log(JSON.stringify({ progress, identity: recovery.identity }));
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  assert.deepEqual(await recovery.advance(), progress);
} finally {
  await recovery.close();
}
await assert.rejects(recovery.check(), /closed/);
console.log(JSON.stringify({ progress, identity: recovery.identity }));
