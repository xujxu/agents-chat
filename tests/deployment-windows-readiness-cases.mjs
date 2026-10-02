import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyWindowsReadiness, waitWindowsReadiness } from '../scripts/deployment/windows-readiness.mjs';

export async function readWindowsReadinessEndpoint(project) {
  const writer = Number(await readFile(path.join(project, 'writer-pid'), 'utf8'));
  const deadline = performance.now() + 5000;
  let endpoint;
  do {
    endpoint = JSON.parse(await readFile(path.join(project, 'listener.json'), 'utf8'));
    assert.ok(performance.now() < deadline, 'Replacement listener did not publish its original identity');
    if (endpoint.pid !== writer) await delay(100);
  } while (endpoint.pid !== writer);
  return endpoint;
}

export async function runWindowsReadinessCases({ context, runtime, project }) {
  const endpoint = await readWindowsReadinessEndpoint(project);
  const options = { context, port: endpoint.port, providers: ['admin-login'] };
  const modeFile = path.join(project, 'health-mode');
  const requestsFile = path.join(project, 'health-requests');
  const mode = async value => {
    await writeFile(modeFile, value);
    await writeFile(requestsFile, '');
  };
  const requests = async () => (await readFile(requestsFile, 'utf8')).trim().split('\n').filter(Boolean);
  await mode('ready');
  const result = await verifyWindowsReadiness(options);
  assert.deepEqual(result, { status: 'ready', generation: runtime.generation, port: endpoint.port, providers: ['admin-login'] });
  assert.deepEqual(await requests(), ['/api/auth/providers']);
  await mode('eventual');
  assert.deepEqual(await waitWindowsReadiness({ ...options, waitSeconds: 30 }), result);
  assert.deepEqual(await requests(), Array(3).fill('/api/auth/providers'));
  await mode('wrong-providers');
  await assert.rejects(waitWindowsReadiness({ ...options, waitSeconds: 30 }), /providers do not match/i);
  assert.deepEqual(await requests(), ['/api/auth/providers']);
  await context.check();
  await mode('hanging');
  const started = performance.now();
  await assert.rejects(verifyWindowsReadiness(options), /HTTP request exceeded its deadline/);
  assert.ok(performance.now() - started >= 3000 && performance.now() - started < 15000);
  await context.check();
  await mode('ready');
  assert.deepEqual(await verifyWindowsReadiness(options), result);
  console.error('PASS: Windows HTTP readiness binds the retained native listener, retries only startup 503, rejects mismatched providers and bounds HTTP responses without releasing activation');
}
