import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { claimWindowsColdRestore } from '../scripts/deployment/windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from '../scripts/deployment/windows-cold-restore-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { verifyWindowsColdReadiness, waitWindowsColdListener } from './deployment-windows-cold-readiness.mjs';
import { windowsColdStartupSteps } from '../scripts/deployment/windows-cold-activation.mjs';
import { captureWindowsColdActivationHistory, captureWindowsColdEnableRequest,
  captureWindowsColdLaunch } from '../scripts/deployment/windows-cold-activation-history.mjs';

const [control, pwsh, mode] = process.argv.slice(2);
assert.ok(mode === undefined || ['crash', 'observed-crash', 'started-crash'].includes(mode), 'Unknown cold activation fixture mode.');
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
  let enableIntent;
  running = await activation.start({ onProgress: async progress => {
    assert.equal(progress.step, windowsColdStartupSteps[steps.length]);
    assert.ok(Object.isFrozen(progress));
    steps.push(progress.step);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lockBytes);
    const requestedBytes = await readFile(path.join(control, 'recovery-lock/activation-start-requested.json'));
    const requested = JSON.parse(requestedBytes);
    assert.equal(requested.version, 2);
    assert.equal(requested.phase, 'start-requested');
    assert.equal(requested.runtime, null);
    if (progress.step !== 'running') {
      await assert.rejects(lstat(path.join(control, 'recovery-lock/activation-running.json')), { code: 'ENOENT' });
    }
    const enablePath = path.join(path.dirname(requested.configuration), 'enable-requested.json');
    if (['requested', 'registered'].includes(progress.step)) {
      await assert.rejects(lstat(enablePath), { code: 'ENOENT' });
    } else {
      const intentBytes = await readFile(path.join(control, 'recovery-lock/activation-intent.json'));
      const history = captureWindowsColdActivationHistory({
        intent: JSON.parse(intentBytes), intentBytes, records: [requestedBytes], taskName: requested.taskName,
      });
      const bytes = await readFile(enablePath);
      const captured = captureWindowsColdEnableRequest({ history, requestBytes: requestedBytes, bytes });
      if (enableIntent) assert.deepEqual(captured, enableIntent);
      else enableIntent = captured;
      await assert.rejects(writeFile(enablePath, bytes));
    }
    if (mode === 'started-crash' && progress.step === 'started') {
      assert.equal(progress.observation, null);
      await waitWindowsColdListener({ project: state.project, originalListener });
      const intentBytes = await readFile(path.join(control, 'recovery-lock/activation-intent.json'));
      const history = captureWindowsColdActivationHistory({
        intent: JSON.parse(intentBytes), intentBytes, records: [requestedBytes], taskName: requested.taskName,
      });
      const bundle = path.dirname(requested.configuration);
      const names = (await readdir(bundle)).filter(name => /^launch-.*\.json$/i.test(name));
      assert.equal(names.length, 1);
      const { record: launch } = captureWindowsColdLaunch({
        history, bytes: await readFile(path.join(bundle, names[0])), originalGeneration: original.generation,
      });
      assert.equal(names[0], `launch-${launch.identity.replace(':', '-')}.json`);
      assert.equal(await processIdentity(launch.pid), launch.identity);
      assert.equal(await processIdentity(launch.controllerPid), launch.controllerIdentity);
      assert.deepEqual(steps, ['requested', 'registered', 'enabled', 'started']);
      console.log(JSON.stringify({
        status: 'guarded-launch', taskName: requested.taskName, runtime: launch,
        controllerPid: requested.controllerPid, controllerIdentity: requested.controllerIdentity,
        configuration: requested.configuration, definition: requested.definition,
        securityDescriptor: requested.securityDescriptor,
      }));
      await new Promise(() => { setInterval(() => {}, 1000); });
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
