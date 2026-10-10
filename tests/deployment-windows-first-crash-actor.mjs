import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareWindowsFirstRuntime } from '../scripts/deployment/windows-first-runtime.mjs';
import { withWindowsFirstBuildFixture, buildWindowsFirstFixture, windowsFirstHttpRuntimeScript } from './deployment-windows-first-build-fixture.mjs';

const [stopAfter, suppliedPort] = process.argv.slice(2);
const port = Number(suppliedPort);
assert.ok(['release-requested', 'lease-released'].includes(stopAfter));
assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
assert.equal(typeof process.send, 'function');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const cleanup = [];
try {
  await withWindowsFirstBuildFixture({ after: callback => cleanup.push(callback) }, async f => {
    await send({ type: 'fixture', project: f.project, control: f.control, taskName: f.taskName,
      operationId: f.lock.operationId, pwsh: f.pwsh });
    const built = await buildWindowsFirstFixture(f);
    await f.record('configuring');
    await f.operation.seal();
    const published = await prepareWindowsFirstRuntime({ ...f, built, port });
    try {
      await published.registerTask({ logonType: 'S4U', triggerType: 'AtStartup' });
      await send({ type: 'registered' });
      await published.prepareActivation();
      await f.record('activating');
      const active = await published.activate();
      await send({ type: 'active', active });
      await published.prepareCompletion({ waitSeconds: 30 });
      await f.record('accepted');
      for (const step of ['policy-requested', 'policy-applied', 'policy-staged', 'release-requested', 'lease-released']) {
        assert.equal(await published.advanceCompletion(), step);
        if (step === stopAfter) break;
      }
      await published.checkFiles();
      await send({ type: 'paused', pid: process.pid, step: stopAfter });
      await delay(120000);
      throw new Error('Parent did not terminate the held first-completion actor.');
    } finally { await published.close(); }
  }, { runtimeScript: windowsFirstHttpRuntimeScript });
} finally {
  for (const close of cleanup.reverse()) await close();
}
