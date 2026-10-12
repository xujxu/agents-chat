import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWindowsColdPolicyRecovery } from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['requested', 'policy-applied', 'restored', 'inspect', 'archive'].includes(target));
const recovery = await prepareWindowsColdPolicyRecovery({ control, pwsh, acceptDataLoss: true });
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
    profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
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
