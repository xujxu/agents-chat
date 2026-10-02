import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-admission.ps1', import.meta.url));
const admissions = new WeakMap();
function refused(cause) {
  return Object.assign(new Error('Windows admission unavailable; retain operation and recovery evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED', recoveryAllowed: false,
  });
}

export async function assertWindowsAdmission(control, admission, options) {
  if (!admissions.has(admission) || admissions.get(admission) !== control) {
    throw new Error('Original retained Windows admission does not match control.');
  }
  await admission.check(options);
}

export async function acquireWindowsAdmission({ control, pwsh, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original Node controller identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon: abandonTransport } = windowsControllerTransport({
    pwsh, refused, label: 'Native admission controller',
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
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity'], 'Windows admission readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original native admission readiness differs.');
    }
    signal?.throwIfAborted();
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('An admission request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Windows admission is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (await processIdentity(process.pid) !== controllerIdentity
          || await processIdentity(child.pid) !== identity.processIdentity) {
          throw new Error('Original admission controller identity changed.');
        }
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value'], 'Windows admission reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.value !== method) {
          throw new Error('Unexpected native admission acknowledgement.');
        }
        if (method === 'close') {
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Native admission close failed.');
          closed = true;
          wire.close();
        }
      } catch (cause) { throw await abandon(cause); }
      finally { busy = false; }
    };
    const admission = Object.freeze({
      identity,
      check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
      async close() {
        if (busy) throw refused(new Error('Cannot close an active admission request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
    admissions.set(admission, control);
    return admission;
  } catch (cause) { throw await abandon(cause); }
}
