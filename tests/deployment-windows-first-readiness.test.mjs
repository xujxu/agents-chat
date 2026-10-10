import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareWindowsFirstRuntime } from '../scripts/deployment/windows-first-runtime.mjs';
import { withWindowsFirstBuildFixture, buildWindowsFirstFixture } from './deployment-windows-first-build-fixture.mjs';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };
const providers = { 'admin-login': { id: 'admin-login', name: 'Admin', type: 'credentials',
  signinUrl: 'http://localhost/api/auth/signin/admin-login', callbackUrl: 'http://localhost/api/auth/callback/admin-login' } };

for (const scenario of ['owned', 'wrong-providers', 'foreign']) {
  test(`Windows first-install readiness binds HTTP authentication providers to the original runtime (${scenario})`, windows, async t => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(providers)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    if (scenario !== 'foreign') await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    else t.after(() => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }));
    const runtimeScript = scenario === 'foreign' ? 'setInterval(() => {}, 1000);' : `
require('node:http').createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(${JSON.stringify(JSON.stringify(scenario === 'owned' ? providers : {}))});
}).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`;
    await withWindowsFirstBuildFixture(t, async f => {
      const built = await buildWindowsFirstFixture(f);
      await f.record('configuring');
      await f.operation.seal();
      const published = await prepareWindowsFirstRuntime({ ...f, built, port });
      let registered = false;
      try {
        assert.equal(typeof published.verifyReadiness, 'function', 'Missing original first-runtime HTTP readiness');
        await assert.rejects(published.verifyReadiness({ waitSeconds: 5 }));
        await published.registerTask({ logonType: 'S4U', triggerType: 'AtStartup' });
        registered = true;
        await published.prepareActivation();
        await f.record('activating');
        const active = await published.activate();
        if (scenario === 'owned') {
          const result = await published.verifyReadiness({ waitSeconds: 15 });
          assert.deepEqual(result, { status: 'ready', generation: active.runtime.generation, port, providers: ['admin-login'] });
          await published.checkFiles();
        } else {
          await assert.rejects(published.verifyReadiness({ waitSeconds: 15 }));
        }
        assert.equal(requests, 0, 'Readiness must never send HTTP to an unrelated listener.');
        assert.equal(existsSync(path.join(f.control, 'deployment.json')), false);
      } finally {
        await published.close();
        if (registered) await execute(path.join(process.env.SystemRoot, 'System32', 'schtasks.exe'),
          ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
      }
    }, { runtimeScript });
  });
}
