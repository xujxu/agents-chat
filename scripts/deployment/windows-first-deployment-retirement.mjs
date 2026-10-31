import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsFirstRetirementRecord } from './windows-first-retirement-record.mjs';
import { verifyWindowsCompletedWorkerEvidence } from './windows-deployment-retirement-evidence.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';

const script = fileURLToPath(new URL('./windows-first-deployment-retirement-controller.ps1', import.meta.url));
function refused(cause) {
  return Object.assign(new Error('First deployment retirement refused; retain original evidence and running application.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_RETIREMENT_REFUSED', recoveryAllowed: false,
  });
}
function capture(value, record) {
  const observed = captureWorkerFields(value, [
    'status', 'operationId', 'stateSha256', 'receiptSha256', 'runtime', 'retiredEntries', 'totalEntries', 'manifestSha256',
  ], 'first retirement observation');
  if (!['retiring', 'retired'].includes(observed.status) || observed.operationId !== record.lock.operationId
    || observed.stateSha256 !== record.state.sha256 || observed.receiptSha256 !== record.receipt.sha256
    || !same(observed.runtime, record.completion.runtime) || observed.totalEntries !== record.entries.length
    || !Number.isSafeInteger(observed.retiredEntries) || observed.retiredEntries < 0
    || observed.retiredEntries > observed.totalEntries || observed.status === 'retired' && observed.retiredEntries !== observed.totalEntries
    || typeof observed.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(observed.manifestSha256)) {
    throw new Error('Invalid first retirement observation.');
  }
  return Object.freeze({ ...observed, runtime: record.completion.runtime });
}

export async function openWindowsFirstDeploymentRetirement({ control, pwsh, admission, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows retirement paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Current first retirement actor identity is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native first deployment retirement',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'record', 'value'], 'first retirement readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Current first retirement bridge differs.');
    }
    const record = captureWindowsFirstRetirementRecord(ready.record);
    if (record.control !== control) throw new Error('First retirement record belongs to another control.');
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const exchange = async (method, requestSignal) => {
      const id = ++sequence;
      await wire.send({ id, method });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 60000 }),
        ['id', 'type', 'value', 'processIdentity'], 'first retirement reply');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
        throw new Error('Unexpected first retirement acknowledgement.');
      }
      if (method === 'close') {
        if (reply.value !== 'close') throw new Error('Unexpected first retirement close acknowledgement.');
        return;
      }
      return capture(reply.value, record);
    };
    let observation;
    if (ready.value === null) {
      if (!same(record.creator, {
        pid: process.pid, processIdentity: controllerIdentity,
        bridgePid: identity.pid, bridgeIdentity: identity.processIdentity,
      })) throw new Error('First retirement candidate belongs to another creator.');
      await verifyWindowsCompletedWorkerEvidence(control, {
        lock: record.lock, workerManifestSha256: record.workerManifestSha256,
        entries: record.entries.filter(entry => entry.path.startsWith('worker-')),
      });
      await verifyHttpReadiness({ port: record.completion.port, providers: record.completion.providers, signal });
      await assertWindowsAdmission(control, admission, { signal });
      observation = await exchange('begin', signal);
      if (observation.retiredEntries !== 0 || observation.status !== 'retiring') {
        throw new Error('First retirement skipped initial evidence.');
      }
    } else { observation = capture(ready.value, record); }
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A first retirement request is already active.'));
      if (failure) throw failure;
      if (closed || method !== 'close' && observation.status === 'retired') {
        throw refused(new Error('First retirement authority is closed or exhausted.'));
      }
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('First retirement bridge exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method === 'advance') {
          if (!same(await exchange('check', requestSignal), observation)) throw new Error('First retirement evidence changed.');
          await verifyHttpReadiness({
            port: record.completion.port, providers: record.completion.providers, signal: requestSignal,
          });
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        const next = await exchange(method, requestSignal);
        if (method === 'close') {
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('First retirement bridge did not close cleanly.');
          closed = true;
          wire.close();
        } else {
          const expected = method === 'check' ? observation : {
            ...observation, retiredEntries: Math.min(observation.retiredEntries + 1, observation.totalEntries),
            status: observation.retiredEntries === observation.totalEntries ? 'retired' : 'retiring',
          };
          if (!same(next, expected)) throw new Error('First retirement changed identity or skipped an entry.');
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
      identity, get observation() { return observation; },
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      advance: ({ signal: requestSignal } = {}) => request('advance', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
