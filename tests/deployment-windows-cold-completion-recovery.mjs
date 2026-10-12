import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWindowsColdCompletionRecovery } from '../scripts/deployment/windows-cold-activation-recovery.mjs';
import { windowsTaskCompletionSteps } from '../scripts/deployment/windows-task-controller.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['permanent-policy-applied', 'enable-applied', 'complete'].includes(target));
const steps = windowsTaskCompletionSteps.filter(step => step !== 'lease-released');
const recovery = await prepareWindowsColdCompletionRecovery({ control, pwsh, acceptDataLoss: true });
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
