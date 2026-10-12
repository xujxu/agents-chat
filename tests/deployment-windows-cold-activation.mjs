import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [control, pwsh] = process.argv.slice(2);
const stateBytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(stateBytes);
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const original = JSON.parse(await readFile(path.join(control, 'task-maintenance/admission.json')));
const lease = await claimWindowsColdRestore({
  control, project: state.project, backup: path.join(control, 'backup'), node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
});
let configuration;
let activation;
let running;
try {
  await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
  configuration = await lease.inspectRestoredConfiguration();
  await lease.retireRuntime();
  activation = await lease.prepareActivation({ configuration });
  assert.equal(typeof activation.start, 'function', 'Cold activation requires an original guarded startup authority.');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(activation.start({ signal: controller.signal }), { name: 'AbortError' });
  await activation.check();
  running = await activation.start();
  assert.equal(running.status, 'guarded-running');
  assert.notEqual(running.runtime.generation, original.generation);
  assert.notEqual(running.runtime.identity, original.ownerIdentity);
  assert.equal(await processIdentity(running.runtime.pid), running.runtime.identity);
  assert.equal(await processIdentity(running.controllerPid), running.controllerIdentity);
  assert.equal(running.configuration, path.join(control, `runtime-${lease.owner.operationId}`, 'configuration.json'));
  assert.deepEqual(await activation.check(), activation.state);
  await configuration.checkFiles();
  await assert.rejects(activation.start(), /already started/);
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
} finally {
  const errors = [];
  try { await lease.close(); } catch (error) { errors.push(error); }
  try { await configuration?.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Cold guarded runtime and configuration cleanup failed.');
}
await assert.rejects(activation.check(), /closed/);
assert.notEqual(await processIdentity(running.runtime.pid), running.runtime.identity);
assert.notEqual(await processIdentity(running.controllerPid), running.controllerIdentity);
assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
console.log(JSON.stringify(running));
