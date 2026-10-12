import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWindowsColdPolicyRecovery } from '../scripts/deployment/windows-cold-activation-recovery.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['requested', 'policy-applied', 'restored', 'inspect'].includes(target));
const recovery = await prepareWindowsColdPolicyRecovery({ control, pwsh, acceptDataLoss: true });
let progress = recovery.observation;
assert.equal(progress.status, 'cold-policy-recovery');
assert.equal(progress.claimed, false);
try {
  if (target === 'inspect') {
    assert.equal(progress.step, 'restored');
  } else {
    let steps = 0;
    while (!progress.claimed || progress.step !== target) {
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
} finally {
  await recovery.close();
}
await assert.rejects(recovery.check(), /closed/);
console.log(JSON.stringify({ status: 'closed', progress }));
