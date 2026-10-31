import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifyWindowsColdReadiness } from './deployment-windows-cold-readiness.mjs';
import { windowsTaskCompletionSteps } from '../scripts/deployment/windows-task-controller.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(target === undefined || target === 'lease-released');
const stateBytes = await readFile(path.join(control, 'state.json'));
const state = JSON.parse(stateBytes);
const lockBytes = await readFile(path.join(control, 'lock/owner.json'));
const lease = await claimWindowsColdRestore({
  control, project: state.project, backup: path.join(control, 'backup'), node: process.execPath, pwsh,
  profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
});
let configuration;
let activation;
let running;
let completed;
try {
  await restoreWindowsColdFiles({ control, lease, acceptDataLoss: true });
  configuration = await lease.inspectRestoredConfiguration();
  const originalListener = await lstat(path.join(state.project, 'listener.json'), { bigint: true });
  await lease.retireRuntime();
  activation = await lease.prepareActivation({ configuration });
  running = await activation.start();
  await verifyWindowsColdReadiness({
    activation, project: state.project, originalListener, runtime: running.runtime, providers: lease.providers,
  });
  assert.equal(typeof activation.completeRuntime, 'function');
  const { port } = JSON.parse(await readFile(path.join(state.project, 'listener.json')));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(activation.completeRuntime({ port, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(activation.completeRuntime({ port, onProgress: true }), { name: 'TypeError' });
  await activation.check();
  const steps = [];
  completed = await activation.completeRuntime({
    port, waitSeconds: 15,
    async onProgress(progress) {
      assert.ok(Object.isFrozen(progress));
      assert.match(progress.completionSha256, /^[a-f0-9]{64}$/);
      assert.equal(progress.lease, steps.length >= windowsTaskCompletionSteps.indexOf('lease-released') ? 'released' : 'guarded');
      steps.push(progress.step);
      const directory = path.join(control, 'recovery-lock');
      const inventory = (await readdir(directory)).sort();
      await delay(100);
      assert.deepEqual((await readdir(directory)).sort(), inventory);
      if (progress.step === target) {
        console.log(JSON.stringify({
          running, progress, identity: { pid: running.controllerPid, processIdentity: running.controllerIdentity },
        }));
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    },
  });
  assert.deepEqual(steps, windowsTaskCompletionSteps);
  assert.equal(completed.status, 'runtime-policy-restored');
  assert.equal(completed.lease, 'released');
  assert.deepEqual(completed.runtime, running.runtime);
  assert.equal(completed.port, port);
  assert.deepEqual(completed.providers, lease.providers);
  assert.deepEqual(await activation.completeRuntime({ port, waitSeconds: 15 }), completed);
  assert.deepEqual(await activation.check(), activation.state);
  await configuration.checkFiles();
} finally {
  const errors = [];
  try { await lease.close(); } catch (error) { errors.push(error); }
  try { await configuration?.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Cold runtime completion cleanup failed.');
}
await assert.rejects(activation.check(), /closed/);
assert.equal(await processIdentity(running.runtime.pid), running.runtime.identity);
assert.notEqual(await processIdentity(running.controllerPid), running.controllerIdentity);
assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
console.log(JSON.stringify({ running, completed }));
