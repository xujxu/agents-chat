import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifyWindowsColdReadiness, waitWindowsColdListener } from './deployment-windows-cold-readiness.mjs';
import { windowsColdStartupSteps } from '../scripts/deployment/windows-cold-activation.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
assert.ok(mode === undefined || ['crash', 'observed-crash'].includes(mode), 'Unknown cold activation fixture mode.');
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
  const originalListener = await lstat(path.join(state.project, 'listener.json'), { bigint: true });
  await lease.retireRuntime();
  activation = await lease.prepareActivation({ configuration });
  assert.equal(typeof activation.start, 'function', 'Cold activation requires an original guarded startup authority.');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(activation.start({ signal: controller.signal }), { name: 'AbortError' });
  await activation.check();
  await assert.rejects(activation.start({ onProgress: 42 }), /progress callback/);
  const steps = [];
  let observed;
  running = await activation.start({ onProgress: async progress => {
    assert.equal(progress.step, windowsColdStartupSteps[steps.length]);
    assert.ok(Object.isFrozen(progress));
    steps.push(progress.step);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
    const requested = JSON.parse(await readFile(path.join(control, 'recovery-lock/activation-start-requested.json')));
    assert.equal(requested.phase, 'start-requested');
    assert.equal(requested.runtime, null);
    if (progress.step !== 'running') {
      await assert.rejects(lstat(path.join(control, 'recovery-lock/activation-running.json')), { code: 'ENOENT' });
    }
    if (progress.step === 'observed') {
      observed = progress.observation;
      assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.runtime));
      const runtime = observed.runtime;
      const launch = JSON.parse(await readFile(path.join(path.dirname(observed.configuration),
        `launch-${runtime.identity.replace(':', '-')}.json`)));
      assert.deepEqual(launch, {
        version: 1, generation: runtime.generation, pid: runtime.pid, identity: runtime.identity,
        configurationSha256: runtime.configurationSha256, sessionId: runtime.sessionId,
        job: `Local\\agents-deploy-${runtime.generation}`,
        controllerPid: observed.controllerPid, controllerIdentity: observed.controllerIdentity,
      });
      assert.equal(await processIdentity(runtime.pid), runtime.identity);
      assert.equal(requested.controllerPid, observed.controllerPid);
      assert.equal(requested.controllerIdentity, observed.controllerIdentity);
      if (mode === 'observed-crash') {
        await waitWindowsColdListener({ project: state.project, originalListener });
        console.log(JSON.stringify(observed));
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    } else if (progress.step === 'running') {
      assert.deepEqual(progress.observation, observed);
    } else {
      assert.equal(progress.observation, null);
    }
  } });
  assert.deepEqual(steps, windowsColdStartupSteps);
  assert.deepEqual(running, observed);
  assert.equal(running.status, 'guarded-running');
  assert.notEqual(running.runtime.generation, original.generation);
  assert.notEqual(running.runtime.identity, original.ownerIdentity);
  assert.equal(await processIdentity(running.runtime.pid), running.runtime.identity);
  assert.equal(await processIdentity(running.controllerPid), running.controllerIdentity);
  assert.equal(running.configuration, path.join(control, `runtime-${lease.owner.operationId}`, 'configuration.json'));
  assert.deepEqual(await activation.check(), activation.state);
  await configuration.checkFiles();
  await assert.rejects(activation.start(), /already started/);
  await verifyWindowsColdReadiness({
    activation, project: state.project, originalListener, runtime: running.runtime, providers: lease.providers,
  });
  assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
  if (mode === 'crash') {
    console.log(JSON.stringify(running));
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
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
