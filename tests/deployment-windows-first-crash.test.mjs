import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const actor = fileURLToPath(new URL('./deployment-windows-first-crash-actor.mjs', import.meta.url));
const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));

for (const step of ['release-requested', 'lease-released']) {
  test(`Windows first-install abrupt actor death preserves the exact original lease boundary (${step})`,
    { skip: process.platform !== 'win32' }, async () => {
      const temporary = await realpath(os.tmpdir());
      const socket = createServer();
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
      const port = socket.address().port;
      await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
      const child = fork(actor, [step, String(port)], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const signal = AbortSignal.timeout(300000);
      const exited = once(child, 'exit', { signal });
      let stderr = '';
      let fixture;
      let active;
      let registered = false;
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
      const paused = new Promise((resolve, reject) => {
        child.on('message', message => {
          if (message?.type === 'fixture') fixture = message;
          else if (message?.type === 'registered') registered = true;
          else if (message?.type === 'active') active = message.active;
          else if (message?.type === 'paused') resolve(message);
          else reject(new Error('Unexpected first-completion actor message.'));
        });
        child.once('error', reject);
      });
      const observe = async mode => JSON.parse((await execute(fixture.pwsh, [
        '-NoProfile', '-NonInteractive', '-File', observer, '-TaskName', fixture.taskName,
        '-OwnerPid', String(active.runtime.pid), '-OwnerIdentity', active.runtime.identity,
        '-Generation', active.runtime.generation, '-Mode', mode,
        '-PublisherPid', String(active.controllerPid), '-PublisherIdentity', active.controllerIdentity,
      ], { timeout: 90000, maxBuffer: 65536 })).stdout);
      try {
        const held = await Promise.race([
          paused, exited.then(() => { throw new Error(`First-completion actor exited before its boundary: ${stderr}`); }),
        ]);
        assert.equal(held.pid, child.pid);
        assert.equal(held.step, step);
        assert.ok(registered && fixture && active);
        const directory = path.join(fixture.control, `first-task-${fixture.operationId}`);
        const release = await readFile(path.join(directory, 'completion-release-requested.json'));
        assert.equal(JSON.parse(release).controllerPid, active.controllerPid);
        assert.deepEqual(JSON.parse(release).runtime, active.runtime);
        const state = await readFile(path.join(fixture.control, 'state.json'));
        const before = await observe('Inspect');
        assert.equal(before.lease, step === 'release-requested' ? 'guarded' : 'released');
        assert.equal(before.binding.enabled, false);
        assert.deepEqual(before.triggers, []);
        assert.deepEqual(before.restart, { count: 0, intervalSeconds: null });
        assert.deepEqual(await observe('KillPublisher'), { status: 'publisher-terminated' });
        assert.equal(child.kill(), true);
        await exited;
        if (step === 'release-requested') {
          assert.deepEqual(await observe('AwaitStopped'), { status: 'already-stopped', enabled: false, instances: 0 });
        } else {
          const surviving = await observe('Inspect');
          assert.equal(surviving.lease, 'released');
          assert.equal(surviving.binding.enabled, false);
          assert.equal(surviving.binding.instanceGuid, active.runtime.instanceGuid);
          assert.ok(surviving.domain.members.includes(active.runtime.launcherPid));
          assert.equal(surviving.domain.quiescent, false);
          assert.equal(surviving.definition, before.definition);
          assert.equal(surviving.securityDescriptor, before.securityDescriptor);
          assert.deepEqual(surviving.triggers, []);
          assert.deepEqual(surviving.restart, { count: 0, intervalSeconds: null });
          const response = await fetch(`http://127.0.0.1:${port}/api/auth/providers`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          assert.deepEqual(Object.keys(await response.json()), ['admin-login']);
        }
        await assert.rejects(readFile(path.join(directory, 'completion-released.json')), { code: 'ENOENT' });
        await assert.rejects(readFile(path.join(directory, 'completion-complete.json')), { code: 'ENOENT' });
        assert.deepEqual(await readFile(path.join(directory, 'completion-release-requested.json')), release);
        assert.deepEqual(await readFile(path.join(fixture.control, 'state.json')), state);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        if (active) await observe('Stop');
        if (registered) await execute(path.join(process.env.SystemRoot, 'System32', 'schtasks.exe'),
          ['/Delete', '/TN', fixture.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
        if (fixture) {
          const root = path.dirname(fixture.project);
          assert.equal(path.dirname(root), temporary);
          assert.match(path.basename(root), /^agents-deployment-test-.+/);
          assert.equal(fixture.control, path.join(root, '.fresh-source.deployment'));
          await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
        }
      }
    });
}
