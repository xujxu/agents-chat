import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsFirstCompletionObservation } from './windows-first-completion-proof.mjs';
import { captureWindowsFirstDeploymentIdentity } from './windows-first-deployment-identity.mjs';

const script = fileURLToPath(new URL('./windows-first-receipt-publication-controller.ps1', import.meta.url));
function refused(cause) {
  return Object.assign(new Error('Cold first receipt publication refused; retain original operation evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_RECEIPT_PUBLICATION_REFUSED', recoveryAllowed: false,
  });
}

export async function openWindowsFirstReceiptPublication({ control, project, operationId, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, project, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows publication paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original publication actor identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native first receipt publisher',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'project', 'controllerIdentity', 'value', 'deploymentIdentity', 'acceptedAt'],
      'first receipt publication readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control || ready.project !== project
      || ready.controllerIdentity !== controllerIdentity || ready.processIdentity !== await processIdentity(child.pid)
      || typeof ready.acceptedAt !== 'string' || !Number.isFinite(Date.parse(ready.acceptedAt))) {
      throw new Error('Original first receipt publication bridge differs.');
    }
    const observation = captureWindowsFirstCompletionObservation(ready.value);
    if (observation.phase !== 'complete' || observation.operationId !== operationId) {
      throw new Error('Complete original first deployment is required.');
    }
    const deploymentIdentity = captureWindowsFirstDeploymentIdentity(ready.deploymentIdentity);
    const request = async (method, requestSignal, service = null) => {
      if (busy) throw refused(new Error('A first receipt publication request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('First receipt publication is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original receipt publisher exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        const id = ++sequence;
        await wire.send({ id, method, service });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'first receipt publication reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
          throw new Error('Unexpected first receipt publication acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected first receipt close acknowledgement.');
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('First receipt publisher did not close cleanly.');
          closed = true;
          wire.close();
          return;
        }
        let result = observation;
        if (method === 'publish') {
          const expected = {
            version: 1, project, operationId, status: 'accepted', acceptedAt: ready.acceptedAt,
            identity: { ...deploymentIdentity, service: createHash('sha256').update(service).digest('hex') },
          };
          if (typeof reply.value !== 'string' || Buffer.byteLength(reply.value) > 8192
            || !same(JSON.parse(reply.value), expected)) throw new Error('Published first receipt differs.');
          result = Object.freeze({ ...expected, identity: Object.freeze(expected.identity) });
        } else if (!same(captureWindowsFirstCompletionObservation(reply.value), observation)) {
          throw new Error('Retained first receipt publication evidence changed.');
        }
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return result;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      observation, deploymentIdentity,
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      publish: ({ service, signal: requestSignal }) => request('publish', requestSignal, JSON.stringify(service)),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
