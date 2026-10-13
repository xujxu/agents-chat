import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsColdRetirementRecord } from './windows-cold-retirement-record.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';

const script = fileURLToPath(new URL('./windows-cold-deployment-retirement-controller.ps1', import.meta.url));
const refused = cause => Object.assign(new Error('Cold retirement refused; retain original evidence and running application.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED', recoveryAllowed: false,
});

function capture(value, record) {
  const observed = captureWorkerFields(value, [
    'status', 'operationId', 'stateSha256', 'receiptSha256', 'runtime', 'retiredEntries', 'totalEntries', 'manifestSha256',
  ], 'cold retirement observation');
  if (!['retiring', 'retired'].includes(observed.status) || observed.operationId !== record.lock.operationId
    || observed.stateSha256 !== record.state.sha256 || observed.receiptSha256 !== record.receipt.sha256
    || !same(observed.runtime, record.completion.runtime) || observed.totalEntries !== record.entries.length
    || !Number.isSafeInteger(observed.retiredEntries) || observed.retiredEntries < 0
    || observed.retiredEntries > observed.totalEntries || observed.status === 'retired' && observed.retiredEntries !== observed.totalEntries
    || typeof observed.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observed.manifestSha256)) {
    throw new Error('Invalid cold retirement observation.');
  }
  return Object.freeze({ ...observed, runtime: record.completion.runtime });
}

export async function openWindowsColdRetirementScope({ control, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows retirement paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Current cold retirement actor identity is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native cold deployment retirement',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'record', 'value'], 'cold retirement readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Current cold retirement bridge differs.');
    }
    const record = captureWindowsColdRetirementRecord(ready.record);
    if (record.control !== control) throw new Error('Cold retirement record belongs to another control.');
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    let observation = capture(ready.value, record);
    const exchange = async (method, requestSignal) => {
      const id = ++sequence;
      await wire.send({ id, method });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 60000 }),
        ['id', 'type', 'value', 'processIdentity'], 'cold retirement reply');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
        throw new Error('Unexpected cold retirement acknowledgement.');
      }
      if (method === 'close') {
        if (reply.value !== 'close') throw new Error('Unexpected cold retirement close acknowledgement.');
        return;
      }
      return capture(reply.value, record);
    };
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A cold retirement request is already active.'));
      if (failure) throw failure;
      if (closed || method !== 'close' && observation.status === 'retired') {
        throw refused(new Error('Cold retirement authority is closed or exhausted.'));
      }
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Cold retirement bridge exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method === 'advance') {
          if (!same(await exchange('check', requestSignal), observation)) throw new Error('Cold retirement evidence changed.');
          await verifyHttpReadiness({ port: record.completion.port, providers: record.completion.providers, signal: requestSignal });
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        const next = await exchange(method, requestSignal);
        if (method === 'close') {
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('Cold retirement bridge did not close cleanly.');
          closed = true;
          wire.close();
        } else {
          const expected = method === 'check' ? observation : {
            ...observation, retiredEntries: Math.min(observation.retiredEntries + 1, observation.totalEntries),
            status: observation.retiredEntries === observation.totalEntries ? 'retired' : 'retiring',
          };
          if (!same(next, expected)) throw new Error('Cold retirement changed identity or skipped an entry.');
          observation = next;
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        return next;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      identity, record, get observation() { return observation; },
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      advance: ({ signal: requestSignal } = {}) => request('advance', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
