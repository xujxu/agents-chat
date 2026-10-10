import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';

const implementation = new URL('../scripts/deployment/windows-first-deployment-retirement.mjs', import.meta.url);
const actor = fileURLToPath(new URL('./deployment-windows-first-retirement-actor.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function crashRetirementActor({ fixture, stopAfter, waitForController }) {
  const child = fork(actor, [fixture.control, fixture.pwsh, String(stopAfter)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(240000) });
  let stderr = '';
  let held;
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
  const paused = new Promise((resolve, reject) => {
    child.once('message', message => message?.type === 'paused'
      ? resolve(message) : reject(new Error('Unexpected first-retirement actor message.')));
    child.once('error', reject);
  });
  try {
    held = await Promise.race([
      paused, exited.then(() => { throw new Error(`First-retirement actor exited before its boundary: ${stderr}`); }),
    ]);
    assert.equal(held.pid, child.pid);
    assert.equal(held.observation.status, 'retiring');
    assert.equal(held.observation.retiredEntries, stopAfter);
    assert.equal(child.kill(), true);
    await exited;
    return held.observation;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    if (held) {
      for (const identity of [held.bridge, held.admission]) {
        assert.deepEqual(await waitForController(identity), { status: 'publisher-exited' });
      }
    }
  }
}

export async function prepareWindowsFirstRetirementCase({
  fixture, active, state, interrupt = false, waitForController, observe,
}) {
  assert.ok(existsSync(implementation), 'Missing first-specific deployment retirement');
  const { openWindowsFirstDeploymentRetirement: open } = await import(implementation);
  const { control, pwsh, project, operationId } = fixture;
  const directory = path.join(control, `first-task-${operationId}`);
  const receiptFile = path.join(control, 'deployment.json');
  const receipt = await readFile(receiptFile);
  const journals = (await readdir(control)).filter(name => /^worker-[a-f0-9-]+\.ndjson$/.test(name));
  const totalEntries = (await readdir(directory)).length + journals.length
    + (await readdir(path.join(control, 'worker-engine'))).length + 5;
  let admission = await acquireWindowsAdmission({ control, pwsh });
  const options = { control, pwsh, admission };
  const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_RETIREMENT_REFUSED';
  const rejectOpen = async predicate => {
    let unexpected;
    try { await assert.rejects(async () => { unexpected = await open(options); }, predicate); }
    finally { if (unexpected) await unexpected.close(); }
  };
  try {
    await rejectOpen(error => refused(error) && error.diagnostic?.includes('original-processes'));
    return {
      async verify() {
        let interrupted;
        if (interrupt) {
          await admission.close();
          for (const stopAfter of [0, 1, totalEntries]) {
            const previous = interrupted;
            interrupted = await crashRetirementActor({ fixture, stopAfter, waitForController });
            if (previous) assert.deepEqual(interrupted, { ...previous, retiredEntries: stopAfter });
            assert.deepEqual(interrupted.runtime, active.runtime);
            assert.equal(interrupted.stateSha256, hash(state));
            assert.equal(interrupted.receiptSha256, hash(receipt));
            const surviving = await observe();
            assert.equal(surviving.binding.instanceGuid, active.runtime.instanceGuid);
            assert.equal(surviving.binding.ownerPid, active.runtime.pid);
            assert.equal(surviving.binding.enabled, true);
            assert.equal(surviving.lease, 'released');
            assert.equal(surviving.domain.quiescent, false);
            assert.ok(surviving.domain.members.includes(active.runtime.launcherPid));
          }
          admission = await acquireWindowsAdmission({ control, pwsh });
          options.admission = admission;
        }
        let scope = await open(options);
        try {
          const initial = scope.observation;
          assert.equal(initial.status, 'retiring');
          assert.equal(initial.operationId, operationId);
          assert.equal(initial.stateSha256, hash(state));
          assert.equal(initial.receiptSha256, hash(receipt));
          assert.deepEqual(initial.runtime, active.runtime);
          assert.equal(initial.retiredEntries, interrupt ? totalEntries : 0);
          if (interrupted) assert.deepEqual(initial, interrupted);
          assert.equal(initial.totalEntries, totalEntries);
          assert.match(initial.manifestSha256, /^[a-f0-9]{64}$/);
          await rejectOpen(refused);
          await assert.rejects(writeFile(receiptFile, receipt));
          for (let index = initial.retiredEntries + 1; index <= totalEntries + 1; index++) {
            const observed = await scope.advance();
            assert.deepEqual(observed, {
              ...initial, status: index > totalEntries ? 'retired' : 'retiring',
              retiredEntries: Math.min(index, totalEntries),
            });
            if (index === 1 || index === totalEntries - 1) {
              await scope.close();
              if (index === 1) {
                const original = path.join(directory, 'completion-complete.json');
                const moved = path.join(path.dirname(control), 'held-first-completion.json');
                await rename(original, moved);
                try { await rejectOpen(refused); }
                finally { await rename(moved, original); }
              }
              scope = await open(options);
              assert.deepEqual(await scope.check(), observed);
            }
          }
        } finally { await scope.close(); }
        const remaining = await readdir(control);
        assert.equal(remaining.includes('lock'), false);
        assert.equal(remaining.some(name => name.startsWith('worker-') || name.startsWith('first-task-')), false);
        assert.deepEqual(await readFile(receiptFile), receipt);
        assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
        assert.ok(remaining.includes(`first-runtime-${operationId}`));
        await admission.close();
        const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
        await releaseLock(control, next, { pwsh });
      },
      close: () => admission.close(),
    };
  } catch (error) {
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First retirement fixture admission cleanup failed.'); }
    throw error;
  }
}
