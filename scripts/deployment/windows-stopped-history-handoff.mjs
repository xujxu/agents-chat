import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { captureLockOwner } from './state.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { captureWindowsStoppedHistoryHandoffPreparedDescriptor } from './windows-stopped-history-handoff-record.mjs';

const script = fileURLToPath(new URL('./windows-stopped-history-handoff-controller.ps1', import.meta.url));
const guid = value => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
function refused(cause) {
  return Object.assign(new Error('Windows handoff preparation unavailable; retain all evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_HANDOFF_PREPARATION_REFUSED', recoveryAllowed: false,
  });
}

export function openWindowsStoppedHistoryHandoffPreparation(options) {
  return openPreparation(options, false);
}

export function reopenWindowsStoppedHistoryHandoffPreparation(options) {
  return openPreparation(options, true);
}

async function openPreparation({
  control, pwsh, admission, signal, project, previousOperationId,
  operation, attemptId, operationId, token, createdAt, prepared,
}, reopen) {
  signal?.throwIfAborted();
  let transport;
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  const abandon = async cause => {
    closed = true;
    failure = await transport.abandon(cause);
    return failure;
  };
  try {
    if (process.platform !== 'win32' || ![control, pwsh, project].every(value =>
      typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
      && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || operation !== 'update' || ![attemptId, previousOperationId, operationId, token].every(guid)
      || new Set([attemptId, previousOperationId, operationId]).size !== 3
      || typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
      || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new Error('Explicit canonical Windows stopped-history preparation identity is required.');
    }
    if (!reopen && prepared !== undefined) throw new Error('Prepared evidence requires explicit controlled reopen.');
    const preparedDescriptor = reopen
      ? captureWindowsStoppedHistoryHandoffPreparedDescriptor(prepared, attemptId) : undefined;
    await assertWindowsAdmission(control, admission, { signal });
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original preparation actor identity is unavailable.');
    captureLockOwner({ version: 1, token, project, operationId, pid: process.pid,
      processIdentity: controllerIdentity, createdAt });
    signal?.throwIfAborted();
    transport = windowsControllerTransport({
      pwsh, refused, label: 'Native stopped-history preparation controller',
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity,
        '-AttemptId', attemptId, '-OperationId', operationId, '-Token', token, '-CreatedAt', createdAt,
        ...(reopen ? ['-ReopenPrepared', '-PreparedDev', preparedDescriptor.dev,
          '-PreparedIno', preparedDescriptor.ino, '-PreparedBytes', String(preparedDescriptor.bytes),
          '-PreparedSha256', preparedDescriptor.sha256] : [])],
    });
    const captureObservation = value => {
      const observed = captureWorkerFields(value,
        ['status', 'attemptId', 'previousOperationId', 'project', 'prepared'], 'handoff preparation observation');
      if (observed.attemptId !== attemptId || observed.previousOperationId !== previousOperationId
        || observed.project !== project
        || !['stopped-history-handoff-ready', 'stopped-history-handoff-prepared'].includes(observed.status)
        || (observed.status === 'stopped-history-handoff-ready') !== (observed.prepared === null)) {
        throw new Error('Native handoff preparation binding differs.');
      }
      return Object.freeze({ ...observed, prepared: observed.prepared === null ? null
        : captureWindowsStoppedHistoryHandoffPreparedDescriptor(observed.prepared, attemptId) });
    };
    const ready = captureWorkerFields(await transport.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'handoff preparation readiness');
    if (ready.type !== 'ready' || ready.pid !== transport.child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(transport.child.pid)) {
      throw new Error('Original native preparation bridge differs.');
    }
    let observation = captureObservation(ready.value);
    if (reopen !== (observation.prepared !== null)
      || (reopen && !isDeepStrictEqual(observation.prepared, preparedDescriptor))) {
      throw new Error('Native preparation bridge initial evidence differs.');
    }
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A handoff preparation request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Handoff preparation is closed.'));
      if (method === 'publish' && observation.prepared !== null) {
        throw refused(new Error('Handoff preparation is already published.'));
      }
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (transport.child.exitCode !== null || transport.child.signalCode !== null) {
          throw new Error('Original preparation bridge exited.');
        }
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        const id = ++sequence;
        await transport.wire.send({ id, method });
        const reply = captureWorkerFields(await transport.wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'handoff preparation reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected native preparation acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected native preparation close.');
          const result = await transport.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Native preparation close failed.');
          closed = true;
          transport.wire.close();
          return;
        }
        const next = captureObservation(reply.value);
        if ((method === 'publish' && next.prepared === null)
          || (method !== 'publish' && next.status !== observation.status)
          || (observation.prepared !== null && !isDeepStrictEqual(next.prepared, observation.prepared))) {
          throw new Error('Native preparation changed its published evidence.');
        }
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        observation = next;
        return method === 'publish' ? observation.prepared : observation;
      } catch (cause) { throw await abandon(cause); }
      finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      identity,
      get observation() { return observation; },
      check: ({ signal: requestSignal = signal } = {}) => request('check', requestSignal),
      publish: ({ signal: requestSignal = signal } = {}) => request('publish', requestSignal),
      async close() {
        if (busy) throw refused(new Error('Cannot close an active handoff preparation request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
  } catch (cause) {
    if (transport) throw await abandon(cause);
    throw refused(cause);
  }
}
