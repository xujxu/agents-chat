import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { windowsTaskCompletionSteps } from './windows-task-controller.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';

const script = fileURLToPath(new URL('./windows-first-completion-recovery-controller.ps1', import.meta.url));
const steps = windowsTaskCompletionSteps.slice(windowsTaskCompletionSteps.indexOf('lease-released'));
const durablePhase = step => ({
  'lease-released': 'release-requested', 'permanent-policy-applied': 'policy-restore-requested',
  'enable-applied': 'enable-requested',
})[step] ?? step;
function refused(cause) {
  return Object.assign(new Error('First completion recovery refused; retain original operation evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_COMPLETION_RECOVERY_REFUSED', recoveryAllowed: false,
  });
}
function capture(value) {
  const record = captureWorkerFields(value, [
    'status', 'phase', 'step', 'operationId', 'taskName', 'stateSha256',
    'completionSha256', 'runtime', 'port', 'providers', 'lease',
  ], 'first completion recovery');
  const { status, phase, step, ...fields } = record;
  if (!steps.includes(step) || phase !== durablePhase(step) || status !== (phase === 'complete' ? 'complete' : 'pending')) {
    throw new Error('Invalid first-completion recovery progress.');
  }
  const common = captureWindowsTaskCompletionProof({ ...fields, status: 'observed', mutationAuthority: false });
  return Object.freeze({ ...record, runtime: common.runtime, providers: common.providers });
}
function identityFields({ status, phase, step, completionSha256, ...fields }) { return fields; }

export async function openWindowsFirstCompletionRecovery({ control, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original first recovery actor identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native first completion recovery controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'first completion recovery readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original first recovery bridge differs.');
    }
    let observation = capture(ready.value);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const exchange = async (method, requestSignal) => {
      const id = ++sequence;
      await wire.send({ id, method });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
        ['id', 'type', 'value', 'processIdentity'], 'first completion recovery reply');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
        throw new Error('Unexpected first completion recovery acknowledgement.');
      }
      if (method === 'close') {
        if (reply.value !== 'close') throw new Error('Unexpected first recovery close acknowledgement.');
        return;
      }
      const next = capture(reply.value);
      if (method === 'check') {
        if (!isDeepStrictEqual(next, observation)) throw new Error('Retained first recovery evidence changed.');
      } else {
        const index = steps.indexOf(observation.step);
        if (next.step !== steps[Math.min(index + 1, steps.length - 1)]
          || !isDeepStrictEqual(identityFields(next), identityFields(observation))
          || (next.phase === observation.phase) !== (next.completionSha256 === observation.completionSha256)) {
          throw new Error('First completion recovery changed original identity or skipped a step.');
        }
      }
      observation = next;
      return next;
    };
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A first recovery request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('First completion recovery is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original first recovery bridge exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method === 'advance') {
          await exchange('check', requestSignal);
          await verifyHttpReadiness({ port: observation.port, providers: observation.providers, signal: requestSignal });
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        const result = await exchange(method, requestSignal);
        if (method === 'close') {
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('First recovery bridge did not close cleanly.');
          closed = true;
          wire.close();
        } else { await assertWindowsAdmission(control, admission, { signal: requestSignal }); }
        return result;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      identity,
      get observation() { return observation; },
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      advance: ({ signal: requestSignal } = {}) => request('advance', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
