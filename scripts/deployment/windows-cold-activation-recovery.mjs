import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { acquireWindowsAdmission, assertWindowsAdmission } from './windows-admission.mjs';
import { inspectWindowsColdRestoreEvidence, windowsColdDirectoryIdentity } from './windows-cold-restore-lease.mjs';
import { captureLockOwner } from './state.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-stopped-restore-controller.ps1', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const refused = cause => Object.assign(new Error('Cold activation observation refused; retain original recovery evidence.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_OBSERVATION_REFUSED', recoveryAllowed: false,
});

export async function inspectWindowsColdActivationRecovery({ control, pwsh, signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value => typeof value === 'string'
    && value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Canonical native Windows control and PowerShell paths are required.'));
  }
  const admission = await acquireWindowsAdmission({ control, pwsh, signal });
  let bridge;
  try {
    const stateBytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
    const state = parse(stateBytes);
    const lock = captureLockOwner(parse(await readWorkerFile(path.join(control, 'lock/owner.json'),
      65536, { privateMode: true })));
    const original = parse(await readWorkerFile(path.join(control, 'task-maintenance/admission.json'),
      1048576, { privateMode: true }));
    const backup = path.join(control, 'backup');
    const snapshot = await verifySnapshot(backup, { signal });
    if (state.operation !== 'restore' || state.operationId !== lock.operationId || state.project !== lock.project
      || snapshot.project !== state.project || snapshot.id !== state.backupId
      || snapshot.source.commit !== state.targetCommit || snapshot.runtime?.platform !== 'win32'
      || snapshot.runtime.task.name !== original.taskName) {
      throw new Error('Cold activation observation differs from its original restore state or archive.');
    }
    const expected = {
      version: 1, project: state.project, backup, backupId: snapshot.id,
      snapshotSha256: digest(Buffer.from(JSON.stringify(snapshot))), recoveryEngine: snapshot.recoveryEngine,
      controlIdentity: await windowsColdDirectoryIdentity(control),
      lockIdentity: await windowsColdDirectoryIdentity(path.join(control, 'lock')),
      lock, state, stateSha256: digest(stateBytes),
    };
    const prior = await inspectWindowsColdRestoreEvidence(control, expected,
      snapshot.runtime.task.configurationSha256, snapshot.source.commit, original.taskName);
    const { guard, staging } = prior;
    const history = guard?.history;
    if (staging || !history || history.phase !== 'stopped' || history.records.length !== 3 || !history.runtime) {
      throw new Error('Cold activation observation requires its complete stopped prefix without staged ownership.');
    }
    const deadOwners = async () => {
      for (const owner of [lock, guard.record.owner,
        { pid: history.controllerPid, processIdentity: history.controllerIdentity },
        { pid: history.runtime.pid, processIdentity: history.runtime.identity }]) {
        if (await processIdentity(owner.pid) === owner.processIdentity) {
          throw new Error('Original cold activation owner, bridge or runtime is still alive.');
        }
      }
    };
    await deadOwners();
    await assertWindowsAdmission(control, admission, { signal });
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original cold activation observer identity is unavailable.');
    const expectedObservation = {
      status: 'cold-activation-stopped', mutationAuthority: false,
      operationId: lock.operationId, taskName: original.taskName, stateSha256: expected.stateSha256,
      ownerSha256: digest(guard.bytes), filesReceiptSha256: digest(guard.receipt.bytes),
      intentSha256: digest(guard.intent.bytes), historySha256: history.sha256, runtime: history.runtime,
    };
    bridge = windowsControllerTransport({
      pwsh, refused, label: 'Native stopped cold activation observer',
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity, '-Recovery', '-ColdActivation',
        '-OwnerSha256', expectedObservation.ownerSha256, '-ReceiptSha256', expectedObservation.filesReceiptSha256,
        '-IntentSha256', expectedObservation.intentSha256, '-HistorySha256', expectedObservation.historySha256],
    });
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'cold observation readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity || ready.processIdentity !== await processIdentity(ready.pid)) {
      throw new Error('Original cold activation observer bridge differs.');
    }
    const capture = value => {
      const observation = captureWorkerFields(value, Object.keys(expectedObservation), 'cold activation observation');
      const runtime = Object.freeze(captureActivatedRuntime(observation.runtime));
      if (!same(observation, expectedObservation)) throw new Error('Original stopped cold activation observation differs.');
      return Object.freeze({ ...observation, runtime });
    };
    const observation = capture(ready.value);
    let closed = false;
    let finished = false;
    let busy = false;
    let sequence = 0;
    const request = async (method, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || busy) throw new Error('Cold activation observation is closed or busy.');
      busy = true;
      try {
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method !== 'close') await deadOwners();
        const id = ++sequence;
        await bridge.wire.send({ id, method });
        const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'cold observation acknowledgement');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
          throw new Error('Original cold activation observer acknowledgement differs.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Cold activation observer close acknowledgement differs.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Cold activation observer did not close cleanly.');
          closed = true;
          bridge.wire.close();
          return;
        }
        const current = capture(reply.value);
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return current;
      } catch (cause) {
        closed = true;
        throw await bridge.abandon(cause);
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      observation,
      check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
      async close() {
        if (busy) throw new Error('Cannot close an active cold activation observation.');
        if (finished) return;
        finished = true;
        const errors = [];
        try { if (!closed) await request('close'); } catch (error) { errors.push(error); }
        try { await admission.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Cold activation observation cleanup failed.');
      },
    });
  } catch (cause) {
    const failure = bridge ? await bridge.abandon(cause) : cause;
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([failure, cleanup], 'Cold activation observation and cleanup failed.'); }
    throw failure;
  }
}
