import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { captureWindowsTaskRetirement } from './windows-task-retirement-record.mjs';

export { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';

const script = fileURLToPath(new URL('./windows-task-completion-controller.ps1', import.meta.url));
const proofs = new WeakMap();
function refused(cause) {
  return Object.assign(new Error('Completed-task proof unavailable; retain operation and recovery evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_COMPLETION_PROOF_REFUSED', recoveryAllowed: false,
  });
}

function bindingFor(control, proof, admission) {
  const binding = proofs.get(proof);
  if (!binding || binding.control !== control || binding.admission !== admission) {
    throw new Error('Original retained completed-task proof does not match admission.');
  }
  return binding;
}

export async function assertWindowsTaskCompletionProof(control, proof, admission, options) {
  bindingFor(control, proof, admission);
  return proof.check(options);
}

export async function prepareWindowsTaskRetirement(control, proof, admission, { signal } = {}) {
  return bindingFor(control, proof, admission).prepare(signal);
}

export async function openWindowsTaskCompletionProof({ control, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original Node controller identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon: abandonTransport } = windowsControllerTransport({
    pwsh, refused, label: 'Native completed-task proof controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  const abandon = async cause => {
    closed = true;
    failure = await abandonTransport(cause);
    return failure;
  };
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'completed-task proof readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original completed-task proof readiness differs.');
    }
    const observation = captureWindowsTaskCompletionProof(ready.value);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const requireOriginalChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Original completed-task proof controller exited.');
      }
    };
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A completed-task proof request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Completed-task proof is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        requireOriginalChild();
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'completed-task proof reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected completed-task proof acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected completed-task proof close acknowledgement.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Native completed-task proof close failed.');
          closed = true;
          wire.close();
          return;
        }
        const prepared = method === 'prepare-retirement' ? captureWindowsTaskRetirement(reply.value) : undefined;
        if (prepared && prepared.intent.control !== control) throw new Error('Retirement intent control differs.');
        const observed = prepared ? prepared.intent.completion : captureWindowsTaskCompletionProof(reply.value);
        if (!isDeepStrictEqual(observed, observation)) throw new Error('Original completed-task proof observation changed.');
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        requireOriginalChild();
        return prepared ?? observed;
      } catch (cause) { throw await abandon(cause); }
      finally { busy = false; }
    };
    await request('check', signal);
    const proof = Object.freeze({
      identity, observation,
      check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
      async close() {
        if (busy) throw refused(new Error('Cannot close an active completed-task proof request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
    proofs.set(proof, { control, admission, prepare: requestSignal => request('prepare-retirement', requestSignal) });
    return proof;
  } catch (cause) { throw await abandon(cause); }
}
