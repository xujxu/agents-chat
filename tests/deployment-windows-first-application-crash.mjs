import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectRecoveryEngineFiles } from '../scripts/deployment/recovery-engine-files.mjs';

const observer = fileURLToPath(new URL('./deployment-windows-first-completion-observer.ps1', import.meta.url));
const optional = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export async function crashWindowsFirstApplication({ args, control, taskName, pwsh }) {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(1800000), cancellation.signal]);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let failure;
  child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString('utf8')).slice(-16384); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-16384); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  const observe = async () => {
    while (true) {
      signal.throwIfAborted();
      const state = await optional(path.join(control, 'state.json'));
      if (state?.phase === 'accepted') {
        assert.match(state.operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        const complete = await optional(path.join(control, `first-task-${state.operationId}`, 'completion-complete.json'));
        if (complete) {
          assert.equal(complete.status, 'first-runtime-completed');
          assert.equal(complete.operationId, state.operationId);
          assert.equal(complete.taskName, taskName);
          return complete;
        }
      }
      await delay(100, undefined, { signal });
    }
  };
  try {
    const complete = await Promise.race([observe(), exited.then(() => {
      throw new Error(`Actual first actor exited before its crash boundary: ${stderr}`);
    })]);
    assert.equal(child.kill(), true, 'Terminate the original actor at its actual completed runtime record.');
    const stopped = await exited;
    assert.notEqual(stopped.code, 0);
    assert.equal(stdout, '', 'Interrupted actor must not report successful deployment.');
    await assert.rejects(readFile(path.join(control, 'deployment.json')), { code: 'ENOENT' });
    const settled = await promisify(execFile)(pwsh, [
      '-NoProfile', '-NonInteractive', '-File', observer, '-TaskName', taskName,
      '-OwnerPid', String(complete.runtime.pid), '-OwnerIdentity', complete.runtime.identity,
      '-Generation', complete.runtime.generation, '-Mode', 'AwaitPublisherExit',
      '-PublisherPid', String(complete.controllerPid), '-PublisherIdentity', complete.controllerIdentity,
    ], { timeout: 90000, maxBuffer: 16384 });
    assert.equal(settled.stderr, '');
    assert.deepEqual(JSON.parse(settled.stdout), { status: 'publisher-exited' });
    await assert.rejects(readFile(path.join(control, 'deployment.json')), { code: 'ENOENT' });
    const saved = await inspectRecoveryEngineFiles({ directory: path.join(control, 'recovery-engine'), signal });
    return { status: 'actor-terminated-before-receipt', operationId: complete.operationId,
      recoveryEngine: saved.manifestSha256 };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    cancellation.abort();
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    try { await exited; }
    catch (cleanup) {
      throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Actual first actor cleanup failed.');
    }
  }
}
