import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const [control, pwshArgument, target] = process.argv.slice(2);
const pwsh = realpathSync.native(pwshArgument);
assert.ok(['requested', 'policy-applied', 'restored', 'inspect', 'archive'].includes(target));
assert.equal(process.env.PATH, undefined);
const snapshot = await verifySnapshot(path.join(control, 'backup'));
const saved = await verifyRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
const captured = name => import(pathToFileURL(path.join(saved.directory, name)));
const { prepareWindowsColdPolicyRecovery } = await captured('windows-cold-activation-recovery.mjs');
const { claimWindowsColdRestore } = await captured('windows-cold-restore-lease.mjs');
const { restoreWindowsColdFiles } = await captured('windows-cold-restore-files.mjs');
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
  { ...snapshot, runtime: { ...snapshot.runtime, task: { ...snapshot.runtime.task, name: 'Foreign-Startup-Task' } } },
  { ...snapshot, entries: [] },
]) {
  await assert.rejects(prepareWindowsColdPolicyRecovery({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: changed,
  }), /differs from the verified saved restore snapshot/);
  for (const [name, before] of originals) {
    const file = path.join(control, name);
    assert.deepEqual(await readFile(file), before.bytes);
    const after = await lstat(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
  }
  assert.deepEqual((await readdir(journal)).sort(), names);
}
const recovery = await prepareWindowsColdPolicyRecovery({
  control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot,
});
let progress = recovery.observation;
assert.equal(progress.status, 'cold-policy-recovery');
assert.equal(progress.claimed, false);
let archived;
try {
  assert.equal(typeof recovery.archive, 'function');
  await assert.rejects(recovery.archive(), /claimed restored policy/);
  if (target === 'inspect') {
    assert.equal(progress.step, 'restored');
  } else {
    let steps = 0;
    while (!progress.claimed || progress.step !== (target === 'archive' ? 'restored' : target)) {
      assert.ok(steps++ < 5, 'Cold policy recovery skipped the requested interruption boundary.');
      progress = await recovery.advance();
    }
  }
  assert.deepEqual(await recovery.check(), progress);
  const file = path.join(control, 'recovery-lock', `policy-${String(progress.policySequence).padStart(6, '0')}.json`);
  const bytes = await readFile(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), progress.policySha256);
  await assert.rejects(writeFile(file, bytes));
  assert.deepEqual(await recovery.check(), progress);
  if (target === 'requested' || target === 'policy-applied') {
    const record = JSON.parse(bytes);
    const owner = Object.fromEntries(['controllerPid', 'controllerIdentity', 'bridgePid', 'bridgeIdentity']
      .map(key => [key, record[key]]));
    assert.equal(owner.controllerPid, process.pid);
    console.log(JSON.stringify({ progress, owner }));
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (target === 'archive') {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(recovery.archive({ signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(await recovery.check(), progress);
    archived = await recovery.archive();
    assert.equal(archived.status, 'cold-policy-archived');
    assert.equal(archived.mutationAuthority, false);
    assert.equal(archived.policySha256, progress.policySha256);
  }
} finally {
  await recovery.close();
}
await assert.rejects(recovery.check(), /closed/);
if (target === 'archive') {
  const state = JSON.parse(await readFile(path.join(control, 'state.json')));
  const lease = await claimWindowsColdRestore({
    control, project: state.project, backup: path.join(control, 'backup'), node: process.execPath, pwsh,
    profile: 'agents-chat-auth-638c553', acceptDataLoss: true, expectedSnapshot: snapshot,
  });
  let restored;
  try {
    restored = await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
    assert.equal(restored.status, 'files-restored');
    await lease.checkStopped();
  } finally { await lease.close(); }
  console.log(JSON.stringify({
    status: 'archived-and-copied', progress, archived,
    ownerId: lease.owner.operationId, runtimeBundle: restored.runtimeBundle.directory,
  }));
} else {
  console.log(JSON.stringify({ status: 'closed', progress }));
}
