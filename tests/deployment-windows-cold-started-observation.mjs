import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureWindowsColdActivationHistory, captureWindowsColdLaunch } from '../scripts/deployment/windows-cold-activation-history.mjs';
import { captureWorkerFields } from '../scripts/deployment/worker-identity.mjs';
import { readWorkerFile } from '../scripts/deployment/worker-files.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

export async function observeWindowsColdStartedLaunch({ control, originalGeneration }) {
  const journal = path.join(control, 'recovery-lock');
  const intentBytes = await readFile(path.join(journal, 'activation-intent.json'));
  const requestBytes = await readFile(path.join(journal, 'activation-start-requested.json'));
  const requested = JSON.parse(requestBytes);
  const history = captureWindowsColdActivationHistory({
    intent: JSON.parse(intentBytes), intentBytes, records: [requestBytes], taskName: requested.taskName,
  });
  const bundle = path.dirname(requested.configuration);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assert.equal(await processIdentity(requested.controllerPid), requested.controllerIdentity);
    const names = (await readdir(bundle)).filter(name => /^launch-.*\.json$/i.test(name));
    assert.ok(names.length <= 1, 'Earlier startup published multiple original launch records.');
    if (!names.length) { await delay(100); continue; }
    const { record: launch } = captureWindowsColdLaunch({
      history, originalGeneration,
      bytes: await readWorkerFile(path.join(bundle, names[0]), 65536, { privateMode: true }),
    });
    assert.equal(names[0], `launch-${launch.identity.replace(':', '-')}.json`);
    assert.equal(await processIdentity(launch.pid), launch.identity);
    let bytes;
    try {
      bytes = await readWorkerFile(path.join(bundle, `runtime-${launch.identity.replace(':', '-')}.json`),
        65536, { privateMode: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(100);
      continue;
    }
    const runtime = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), [
      'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job', 'launcherPid',
    ], 'actual earlier startup readiness');
    for (const key of ['version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job']) {
      assert.equal(runtime[key], launch[key]);
    }
    assert.ok(Number.isSafeInteger(runtime.launcherPid) && runtime.launcherPid > 0 && runtime.launcherPid <= 2147483647);
    return {
      status: 'guarded-launch', taskName: requested.taskName, runtime,
      controllerPid: requested.controllerPid, controllerIdentity: requested.controllerIdentity,
      configuration: requested.configuration, plannedDefinition: requested.definition,
      securityDescriptor: requested.securityDescriptor,
    };
  }
  throw new Error('Original pre-inhibition launch/readiness evidence did not arrive within 120 seconds.');
}
