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
import { prepareWindowsFirstProofCase } from './deployment-windows-first-proof-cases.mjs';
import { prepareWindowsFirstRecoveryCase } from './deployment-windows-first-recovery-cases.mjs';

const execute = promisify(execFile);
const actor = fileURLToPath(new URL('./deployment-windows-first-crash-actor.mjs', import.meta.url));
const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));

for (const scenario of [
  { step: 'release-requested' }, { step: 'lease-released' }, { step: 'lease-released', proof: true },
  { step: 'lease-released', recovery: true }, { step: 'permanent-policy-applied', recovery: true },
  { step: 'enable-applied', recovery: true },
  { step: 'lease-released', recovery: true, stopRecoveryAfter: 'released' },
  { step: 'lease-released', recovery: true, stopRecoveryAfter: 'permanent-policy-applied' },
  { step: 'lease-released', recovery: true, stopRecoveryAfter: 'enable-applied' },
]) {
  const { step } = scenario;
  const name = scenario.stopRecoveryAfter ? `recovery-actor-${scenario.stopRecoveryAfter}`
    : scenario.proof ? 'cold-proof' : scenario.recovery ? `cold-recovery-${step}` : step;
  test(`Windows first-install abrupt actor death preserves the exact original lease boundary (${name})`,
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
      let proofCase;
      let recoveryCase;
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
      const observe = async (mode, publisher = { pid: active.controllerPid, processIdentity: active.controllerIdentity }) => JSON.parse((await execute(fixture.pwsh, [
        '-NoProfile', '-NonInteractive', '-File', observer, '-TaskName', fixture.taskName,
        '-OwnerPid', String(active.runtime.pid), '-OwnerIdentity', active.runtime.identity,
        '-Generation', active.runtime.generation, '-Mode', mode,
        '-PublisherPid', String(publisher.pid), '-PublisherIdentity', publisher.processIdentity,
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
        assert.equal(before.binding.enabled, step === 'enable-applied');
        const permanent = ['permanent-policy-applied', 'enable-applied'].includes(step);
        assert.deepEqual(before.triggers, permanent ? [{ type: 8, enabled: true }] : []);
        assert.deepEqual(before.restart, permanent ? { count: 3, intervalSeconds: 60 } : { count: 0, intervalSeconds: null });
        if (scenario.proof) proofCase = await prepareWindowsFirstProofCase({ fixture, active, port, release, state });
        if (scenario.recovery) recoveryCase = await prepareWindowsFirstRecoveryCase({
          fixture, active, step, port, release, state, stopRecoveryAfter: scenario.stopRecoveryAfter,
          waitForController: identity => observe('AwaitPublisherExit', identity), observe: () => observe('Inspect'),
        });
        assert.deepEqual(await observe('KillPublisher'), { status: 'publisher-terminated' });
        assert.equal(child.kill(), true);
        await exited;
        if (step === 'release-requested') {
          assert.deepEqual(await observe('AwaitStopped'), { status: 'already-stopped', enabled: false, instances: 0 });
        } else {
          const surviving = await observe('Inspect');
          assert.equal(surviving.lease, 'released');
          assert.equal(surviving.binding.enabled, before.binding.enabled);
          assert.equal(surviving.binding.instanceGuid, active.runtime.instanceGuid);
          assert.ok(surviving.domain.members.includes(active.runtime.launcherPid));
          assert.equal(surviving.domain.quiescent, false);
          assert.equal(surviving.definition, before.definition);
          assert.equal(surviving.securityDescriptor, before.securityDescriptor);
          assert.deepEqual(surviving.triggers, before.triggers);
          assert.deepEqual(surviving.restart, before.restart);
          const response = await fetch(`http://127.0.0.1:${port}/api/auth/providers`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          assert.deepEqual(Object.keys(await response.json()), ['admin-login']);
        }
        if (proofCase) {
          await proofCase.verify();
          const afterProof = await observe('Inspect');
          assert.equal(afterProof.binding.instanceGuid, active.runtime.instanceGuid);
          assert.equal(afterProof.lease, 'released');
          assert.equal(afterProof.definition, before.definition);
          assert.equal(afterProof.domain.quiescent, false);
        }
        if (recoveryCase) {
          await recoveryCase.verify();
          const recovered = await observe('Inspect');
          assert.equal(recovered.binding.instanceGuid, active.runtime.instanceGuid);
          assert.equal(recovered.binding.ownerPid, active.runtime.pid);
          assert.equal(recovered.binding.enabled, true);
          assert.equal(recovered.lease, 'released');
          assert.equal(recovered.securityDescriptor, before.securityDescriptor);
          assert.equal(recovered.domain.quiescent, false);
          assert.ok(recovered.domain.members.includes(active.runtime.launcherPid));
          assert.deepEqual(recovered.triggers, [{ type: 8, enabled: true }]);
          assert.deepEqual(recovered.restart, { count: 3, intervalSeconds: 60 });
          const response = await fetch(`http://127.0.0.1:${port}/api/auth/providers`, { signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 200);
          assert.deepEqual(Object.keys(await response.json()), ['admin-login']);
        } else {
          await assert.rejects(readFile(path.join(directory, 'completion-released.json')), { code: 'ENOENT' });
          await assert.rejects(readFile(path.join(directory, 'completion-complete.json')), { code: 'ENOENT' });
        }
        assert.deepEqual(await readFile(path.join(directory, 'completion-release-requested.json')), release);
        assert.deepEqual(await readFile(path.join(fixture.control, 'state.json')), state);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        if (proofCase) await proofCase.close();
        if (recoveryCase) await recoveryCase.close();
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
