import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { windowsControllerTransport } from '../scripts/deployment/windows-controller-transport.mjs';
import {
  openWindowsTaskCompletionProof, assertWindowsTaskCompletionProof, captureWindowsTaskCompletionProof,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh, mode] = process.argv.slice(2);

async function malformedRequest(frame) {
  const controllerIdentity = await processIdentity(process.pid);
  const script = fileURLToPath(new URL('../scripts/deployment/windows-task-completion-controller.ps1', import.meta.url));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused: cause => cause, label: 'Malformed completion fixture',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(90000) });
  closed.catch(() => {});
  try {
    const ready = await wire.receive({ timeoutMs: 60000 });
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, child.pid);
    await new Promise((resolve, reject) => child.stdin.write(`${frame}\n`, error => error ? reject(error) : resolve()));
    assert.equal((await waitForExit()).code, 1);
    await closed;
    const result = await abandon(new Error('Expected malformed completion request refusal.'));
    assert.match(result.diagnostic, /Completed-task proof refused: request\./);
  } catch (error) { throw await abandon(error); }
}

if (mode === 'hold') {
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      await new Promise((resolve, reject) => process.send(
        { proof: proof.identity, admission: admission.identity }, error => error ? reject(error) : resolve()));
      await delay(120000);
      throw new Error('Parent did not terminate original completion fixture controller.');
    } finally { await proof.close(); }
  });
} else {
  await withWindowsAdmission(control, { pwsh }, async admission => {
    await assert.rejects(openWindowsTaskCompletionProof({
      control, pwsh, admission: Object.freeze({ check: async () => {} }),
    }), /Original retained Windows admission/);
    await assert.rejects(openWindowsTaskCompletionProof({
      control: `${control}-foreign`, pwsh, admission,
    }), /Original retained Windows admission/);
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try {
      assert.equal(proof.observation.status, 'observed');
      assert.equal(proof.observation.mutationAuthority, false);
      assert.equal(proof.observation.lease, 'released');
      assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.observation)
        && Object.isFrozen(proof.observation.runtime) && Object.isFrozen(proof.observation.providers));
      assert.deepEqual(captureWindowsTaskCompletionProof(structuredClone(proof.observation)), proof.observation);
      for (const changed of [
        { ...proof.observation, unexpected: true },
        { ...proof.observation, mutationAuthority: true },
        { ...proof.observation, lease: 'guarded' },
        { ...proof.observation, operationId: '00000000-0000-0000-0000-000000000000' },
        { ...proof.observation, port: String(proof.observation.port) },
        { ...proof.observation, stateSha256: 'bad' },
        { ...proof.observation, runtime: { ...proof.observation.runtime, identity: 'invalid' } },
        { ...proof.observation, providers: [] },
        { ...proof.observation, providers: [...proof.observation.providers, ...proof.observation.providers] },
      ]) assert.throws(() => captureWindowsTaskCompletionProof(changed));
      assert.deepEqual(await assertWindowsTaskCompletionProof(control, proof, admission), proof.observation);
      await assert.rejects(assertWindowsTaskCompletionProof(control, { ...proof }, admission),
        /Original retained completed-task proof/);
      await assert.rejects(assertWindowsTaskCompletionProof(`${control}-foreign`, proof, admission),
        /Original retained completed-task proof/);
      await assert.rejects(acquireLock(control, { pwsh }),
        error => /acquire\/busy/.test(error.diagnostic ?? ''));
    } finally { await proof.close(); }
    await assert.rejects(proof.check(), /Completed-task proof unavailable/);
    await proof.close();
    await admission.check();
    for (const frame of [
      '{"id":1,"method":"delete"}',
      '{"id":2,"method":"check"}',
      '{"id":1,"method":"check","method":"close"}',
      `{"id":1,"method":"${'x'.repeat(4096)}"}`,
    ]) await malformedRequest(frame);
  });

  const child = fork(fileURLToPath(import.meta.url), [control, pwsh, 'hold'], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-4096); });
  const deadline = AbortSignal.timeout(90000);
  const exited = once(child, 'exit', { signal: deadline });
  exited.catch(() => {});
  let identities;
  let failure;
  try {
    const [ready] = await Promise.race([
      once(child, 'message', { signal: deadline }),
      exited.then(() => { throw new Error(`Completion fixture exited before readiness: ${stderr}`); }),
    ]);
    identities = [ready.proof, ready.admission];
    for (const identity of identities) {
      assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
      assert.equal(await processIdentity(identity.pid), identity.processIdentity);
    }
  } catch (error) { failure = error; }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try { await exited; }
    catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Completion fixture and exit failed.') : error;
    }
  }
  if (failure) throw failure;
  const until = Date.now() + 20000;
  for (const identity of identities) {
    while (await processIdentity(identity.pid) === identity.processIdentity) {
      assert.ok(Date.now() < until, 'Original native completion/admission controller survived its Node owner.');
      await delay(100);
    }
  }
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
    try { await proof.check(); }
    finally { await proof.close(); }
  });
  console.log('PASS: retained completed-task proof excludes competitors, rejects forged/closed contexts and malformed requests, and follows original controller exit without mutation');
}
