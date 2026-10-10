import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { openWindowsFirstCompletionRecovery } from '../scripts/deployment/windows-first-completion-recovery.mjs';
import { windowsTaskCompletionSteps } from '../scripts/deployment/windows-task-controller.mjs';

const [control, pwsh, stopAfter] = process.argv.slice(2);
assert.ok(['released', 'permanent-policy-applied', 'enable-applied'].includes(stopAfter));
assert.equal(typeof process.send, 'function');
const admission = await acquireWindowsAdmission({ control, pwsh });
let recovery;
try {
  recovery = await openWindowsFirstCompletionRecovery({ control, pwsh, admission });
  const target = windowsTaskCompletionSteps.indexOf(stopAfter);
  while (recovery.observation.step !== stopAfter) {
    const current = windowsTaskCompletionSteps.indexOf(recovery.observation.step);
    assert.ok(current >= 0 && current < target, 'Recovery actor passed its requested crash boundary.');
    await recovery.advance();
  }
  await recovery.check();
  await new Promise((resolve, reject) => process.send({
    type: 'paused', pid: process.pid, admission: admission.identity,
    bridge: recovery.identity, observation: recovery.observation,
  }, error => error ? reject(error) : resolve()));
  await delay(120000);
  throw new Error('Parent did not terminate the held first-recovery actor.');
} finally {
  try { if (recovery) await recovery.close(); }
  finally { await admission.close(); }
}
