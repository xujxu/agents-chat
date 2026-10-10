import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { captureWindowsFirstDeploymentIdentity } from './windows-first-deployment-identity.mjs';

const script = fileURLToPath(new URL('./windows-first-completion-proof-controller.ps1', import.meta.url));
const proofs = new WeakMap();
function refused(cause) {
  return Object.assign(new Error('First completion proof unavailable; retain original operation evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_COMPLETION_PROOF_REFUSED', recoveryAllowed: false,
  });
}
export function captureWindowsFirstCompletionObservation(value) {
  const record = captureWorkerFields(value, [
    'status', 'mutationAuthority', 'phase', 'operationId', 'taskName', 'stateSha256',
    'completionSha256', 'runtime', 'port', 'providers', 'lease',
  ], 'first completion proof');
  const { status, phase, ...fields } = record;
  if (status !== 'first-completion-observed' || ![
    'release-requested', 'released', 'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete',
  ].includes(phase)) {
    throw new Error('Unsupported first-completion proof boundary.');
  }
  return Object.freeze({ ...captureWindowsTaskCompletionProof({ ...fields, status: 'observed' }), status, phase });
}

export async function assertWindowsFirstCompletionProof(control, proof, admission, options) {
  const binding = proofs.get(proof);
  if (!binding || binding.control !== control || binding.admission !== admission) {
    throw refused(new Error('Original first-completion proof does not match retained admission.'));
  }
  return proof.check(options);
}

export async function openWindowsFirstCompletionProof({ control, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original first-proof actor identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native first completion proof controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value', 'deploymentIdentity'],
      'first completion proof readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original first-completion proof bridge differs.');
    }
    const observation = captureWindowsFirstCompletionObservation(ready.value);
    const deploymentIdentity = ready.deploymentIdentity === null ? null
      : captureWindowsFirstDeploymentIdentity(ready.deploymentIdentity);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A first-completion proof request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('First-completion proof is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original first-proof bridge exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'first completion proof reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected first-completion proof acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected first-proof close acknowledgement.');
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('First-proof bridge did not close cleanly.');
          closed = true;
          wire.close();
          return;
        }
        if (!isDeepStrictEqual(captureWindowsFirstCompletionObservation(reply.value), observation)) {
          throw new Error('Retained first-completion evidence changed.');
        }
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
      identity, observation, deploymentIdentity,
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
    proofs.set(proof, { control, admission });
    return proof;
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
