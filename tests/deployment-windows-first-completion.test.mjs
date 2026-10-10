import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareWindowsFirstRuntime } from '../scripts/deployment/windows-first-runtime.mjs';
import { withWindowsFirstBuildFixture, buildWindowsFirstFixture } from './deployment-windows-first-build-fixture.mjs';

const execute = promisify(execFile);
const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));
const runtimeScript = `
require('node:http').createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ 'admin-login': { id: 'admin-login', name: 'Admin', type: 'credentials',
    signinUrl: 'http://localhost/api/auth/signin/admin-login', callbackUrl: 'http://localhost/api/auth/callback/admin-login' } }));
}).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`;

test('Windows first-install completion preserves the original ready runtime after permanent-policy handoff and controller close',
  { skip: process.platform !== 'win32' }, async t => {
    const socket = createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    await withWindowsFirstBuildFixture(t, async f => {
      const built = await buildWindowsFirstFixture(f);
      await f.record('configuring');
      await f.operation.seal();
      const published = await prepareWindowsFirstRuntime({ ...f, built, port });
      let registered = false;
      let active;
      const observe = async mode => JSON.parse((await execute(f.pwsh, [
        '-NoProfile', '-NonInteractive', '-File', observer, '-TaskName', f.taskName,
        '-OwnerPid', String(active.runtime.pid), '-OwnerIdentity', active.runtime.identity,
        '-Generation', active.runtime.generation, '-Mode', mode,
      ], { timeout: 90000, maxBuffer: 65536 })).stdout);
      try {
        assert.equal(typeof published.complete, 'function', 'Missing original first-runtime permanent completion');
        await assert.rejects(published.complete());
        const task = await published.registerTask({ logonType: 'S4U', triggerType: 'AtStartup' });
        registered = true;
        await published.prepareActivation();
        await f.record('activating');
        active = await published.activate();
        await assert.rejects(published.complete());
        await published.prepareCompletion({ waitSeconds: 30 });
        await assert.rejects(published.complete());
        await published.checkFiles();
        await f.record('accepted');
        const completed = await published.complete();
        assert.equal(completed.status, 'first-runtime-completed');
        assert.equal(completed.controllerPid, active.controllerPid);
        assert.equal(completed.controllerIdentity, active.controllerIdentity);
        assert.deepEqual(completed.runtime, active.runtime);
        assert.equal(completed.enabled, true);
        assert.equal(completed.lease, 'released');
        assert.equal(completed.securityDescriptor, task.securityDescriptor);
        await assert.rejects(published.complete());
        await published.checkFiles();
        assert.deepEqual(JSON.parse(await readFile(path.join(f.control,
          `first-task-${f.lock.operationId}`, 'completion-complete.json'), 'utf8')), completed);
        const completionDirectory = path.join(f.control, `first-task-${f.lock.operationId}`);
        let previous = createHash('sha256').update(await readFile(path.join(completionDirectory, 'completion-prepared.json'))).digest('hex');
        for (const phase of ['policy-requested', 'policy-staged', 'release-requested', 'released',
          'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete']) {
          const bytes = await readFile(path.join(completionDirectory, `completion-${phase}.json`));
          const record = JSON.parse(bytes);
          assert.equal(record.phase, phase);
          assert.equal(record.previousSha256, previous);
          assert.deepEqual(record.runtime, active.runtime);
          assert.equal(record.securityDescriptor, task.securityDescriptor);
          assert.equal(record.enabled, phase === 'complete');
          assert.equal(record.lease, ['policy-requested', 'policy-staged', 'release-requested'].includes(phase) ? 'guarded' : 'released');
          if (phase !== 'policy-requested') assert.doesNotMatch(record.definition, /-ControllerPid|-ControllerIdentity/);
          if (!['policy-restored', 'enable-requested', 'complete'].includes(phase)) {
            assert.doesNotMatch(record.definition, /<BootTrigger>|<RestartOnFailure>/);
          }
          previous = createHash('sha256').update(bytes).digest('hex');
        }
        await published.close();
        const after = await observe('Inspect');
        assert.equal(after.lease, 'released');
        assert.equal(after.domain.phase, 'admitted');
        assert.equal(after.domain.quiescent, false);
        assert.ok(after.domain.members.includes(active.runtime.launcherPid));
        assert.equal(after.binding.enabled, true);
        assert.equal(after.binding.instanceGuid, active.runtime.instanceGuid);
        assert.equal(after.binding.ownerPid, active.runtime.pid);
        assert.equal(after.definition, completed.definition);
        assert.equal(after.securityDescriptor, task.securityDescriptor);
        assert.match(after.definition, /<BootTrigger>/);
        assert.match(after.definition, /<RestartOnFailure>/);
        assert.doesNotMatch(after.definition, /-ControllerPid|-ControllerIdentity/);
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/providers`, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(await response.json()), ['admin-login']);
      } finally {
        try { await published.close(); }
        finally {
          if (active) await observe('Stop');
          if (registered) await execute(path.join(process.env.SystemRoot, 'System32', 'schtasks.exe'),
            ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
        }
      }
    }, { runtimeScript });
  });
