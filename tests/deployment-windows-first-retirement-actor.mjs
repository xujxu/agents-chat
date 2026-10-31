import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { openWindowsFirstDeploymentRetirement } from '../scripts/deployment/windows-first-deployment-retirement.mjs';

const [control, pwsh, boundary] = process.argv.slice(2);
const stopAfter = Number(boundary);
assert.ok(Number.isSafeInteger(stopAfter) && stopAfter >= 0);
assert.equal(typeof process.send, 'function');
const admission = await acquireWindowsAdmission({ control, pwsh });
let retirement;
try {
  retirement = await openWindowsFirstDeploymentRetirement({ control, pwsh, admission });
  assert.ok(stopAfter <= retirement.observation.totalEntries);
  assert.ok(retirement.observation.retiredEntries <= stopAfter);
  while (retirement.observation.retiredEntries < stopAfter) await retirement.advance();
  await retirement.check();
  await new Promise((resolve, reject) => process.send({
    type: 'paused', pid: process.pid, admission: admission.identity,
    bridge: retirement.identity, observation: retirement.observation,
  }, error => error ? reject(error) : resolve()));
  await delay(120000);
  throw new Error('Parent did not terminate the held first-retirement actor.');
} finally {
  try { if (retirement) await retirement.close(); }
  finally { await admission.close(); }
}
