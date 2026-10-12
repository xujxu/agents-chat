import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';

const script = fileURLToPath(new URL('./windows-stopped-restore-controller.ps1', import.meta.url));
const proofs = new WeakMap();
function refused(cause) {
  return Object.assign(new Error('Stopped restore proof unavailable; retain original recovery evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_STOPPED_RESTORE_PROOF_REFUSED', recoveryAllowed: false,
  });
}
function capture(value) {
  const observation = captureWorkerFields(value, [
    'status', 'mutationAuthority', 'operationId', 'taskName', 'stateSha256', 'stopped', 'inhibited',
  ], 'stopped restore proof');
  if (observation.status !== 'observed' || observation.mutationAuthority !== false
    || observation.stopped !== true || observation.inhibited !== true
    || typeof observation.operationId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(observation.operationId)
    || observation.operationId === '00000000-0000-0000-0000-000000000000'
    || typeof observation.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(observation.taskName)
    || typeof observation.stateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observation.stateSha256)) {
    throw new Error('Stopped restore observation is not an original read-only proof.');
  }
  return Object.freeze(observation);
}

export async function assertWindowsStoppedRestoreProof(control, proof, admission, options) {
  const binding = proofs.get(proof);
  if (!binding || binding.control !== control || binding.admission !== admission) {
    throw refused(new Error('Stopped restore proof differs from its original admission.'));
  }
  return proof.check(options);
}

export async function openWindowsStoppedRestoreProof({ control, pwsh, admission, signal, recovery = false }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || typeof recovery !== 'boolean' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Canonical native Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original stopped restore observer identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native stopped restore proof controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity, ...(recovery ? ['-Recovery'] : [])],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'stopped restore proof readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original stopped restore proof bridge differs.');
    }
    const observation = capture(ready.value);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A stopped restore proof request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Stopped restore proof is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original stopped restore bridge exited.');
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'stopped restore proof reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected stopped restore proof acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected stopped restore proof close acknowledgement.');
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('Stopped restore bridge did not close cleanly.');
          closed = true;
          wire.close();
          return;
        }
        if (!isDeepStrictEqual(capture(reply.value), observation)) throw new Error('Original stopped restore proof changed.');
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return observation;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    const proof = Object.freeze({
      identity, observation,
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      async close() {
        if (busy) throw refused(new Error('Cannot close an active stopped restore proof request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
    proofs.set(proof, { control, admission });
    return proof;
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
