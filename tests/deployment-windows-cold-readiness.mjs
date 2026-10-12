import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export async function verifyWindowsColdReadiness({ activation, project, originalListener, runtime, providers }) {
  assert.equal(typeof activation.waitReady, 'function', 'Cold startup requires owned listener and admitted HTTP readiness.');
  let listener;
  const deadline = Date.now() + 15000;
  const file = path.join(project, 'listener.json');
  // The fixture atomically replaces this file; a recycled PID does not prove new publication.
  do {
    const before = await lstat(file, { bigint: true });
    if (before.dev !== originalListener.dev || before.ino !== originalListener.ino) {
      listener = JSON.parse(await readFile(file));
      const after = await lstat(file, { bigint: true });
      if (after.dev === before.dev && after.ino === before.ino) break;
    }
    assert.ok(Date.now() < deadline, 'New cold application listener was not published.');
    await pause(100);
  } while (true);
  assert.ok(Number.isSafeInteger(listener.port) && listener.port > 0);
  await assert.rejects(activation.waitReady({ port: 0 }), /port/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(activation.waitReady({ port: listener.port, signal: controller.signal }), { name: 'AbortError' });
  await activation.check();
  await writeFile(path.join(project, 'health-mode'), 'wrong-providers');
  await assert.rejects(activation.waitReady({ port: listener.port, waitSeconds: 5 }), /providers do not match/);
  await activation.check();
  await writeFile(path.join(project, 'health-mode'), 'eventual');
  assert.deepEqual(await activation.waitReady({ port: listener.port, waitSeconds: 15 }), {
    status: 'ready', generation: runtime.generation, port: listener.port, providers,
  });
  const requests = (await readFile(path.join(project, 'health-requests'), 'utf8')).trim().split('\n');
  assert.ok(requests.length >= 4, 'Readiness must reject wrong providers and retry only transient startup responses.');
  assert.ok(requests.every(value => value === '/api/auth/providers'));
  assert.deepEqual(await activation.check(), activation.state);
}
