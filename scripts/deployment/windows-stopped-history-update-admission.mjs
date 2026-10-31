import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { openWindowsStoppedHistoryHandoffPreparation } from './windows-stopped-history-handoff.mjs';
import {
  captureWindowsInactiveTaskHandoffAdmission, inspectWindowsInactiveTaskHandoff,
} from './windows-managed-task.mjs';

const script = fileURLToPath(new URL('./windows-stopped-history-handoff-commit-controller.ps1', import.meta.url));
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

function refused(cause) {
  return Object.assign(new Error('Windows stopped-history update admission unavailable; retain all evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_HANDOFF_ADMISSION_REFUSED', recoveryAllowed: false,
  });
}

function descriptor(value, name) {
  const captured = captureWorkerFields(value, ['path', 'dev', 'ino', 'bytes', 'sha256'], 'handoff descriptor');
  if (captured.path !== name || !/^\d+$/.test(captured.dev) || !/^\d+$/.test(captured.ino)
    || !Number.isSafeInteger(captured.bytes) || captured.bytes <= 0 || !/^[a-f0-9]{64}$/.test(captured.sha256)) {
    throw new Error('Native handoff commit descriptor differs.');
  }
  return captured;
}

// Composes the first-attempt handoff for a fresh update of archived stopped history: the live controller prepares,
// commits its lock, publishes its state intent and writes preflight, then only handoff-aware admission is accepted.
// No step grants lock release; any failure retains its evidence for explicit takeover.
export async function admitWindowsStoppedHistoryUpdate({ project, control, taskName, pwsh, admission, signal }) {
  let scope;
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' || ![project, control, pwsh].every(canonical)
      || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)) {
      throw new Error('Explicit canonical Windows stopped-history update admission is required.');
    }
    await assertWindowsAdmission(control, admission, { signal });
    const previous = await loadState(control);
    if (!previous || previous.project !== project) throw new Error('Archived stopped history belongs to another project.');
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original update actor identity is unavailable.');
    const attemptId = randomUUID();
    const owner = { token: randomUUID(), operationId: randomUUID(), createdAt: new Date().toISOString() };
    const lock = captureLockOwner({ version: 1, ...owner, project, pid: process.pid, processIdentity: controllerIdentity });
    const preparation = await openWindowsStoppedHistoryHandoffPreparation({
      control, pwsh, admission, signal, project, previousOperationId: previous.operationId,
      operation: 'update', attemptId, ...owner,
    });
    let prepared;
    try { prepared = await preparation.publish({ signal }); }
    finally { await preparation.close(); }
    const run = promisify(execFile)(pwsh, [
      '-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity,
      '-AttemptId', attemptId, '-OperationId', owner.operationId, '-Token', owner.token, '-CreatedAt', owner.createdAt,
      '-PreparedDev', prepared.dev, '-PreparedIno', prepared.ino,
      '-PreparedBytes', String(prepared.bytes), '-PreparedSha256', prepared.sha256,
    ], { timeout: 60000, maxBuffer: 131072, windowsHide: true, signal });
    const { stdout, stderr } = await run;
    if (stderr !== '') throw new Error('Native handoff commit reported diagnostics.');
    const reply = captureWorkerFields(JSON.parse(stdout),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'handoff commit result');
    if (reply.type !== 'result' || reply.pid !== run.child.pid || typeof reply.processIdentity !== 'string'
      || reply.control !== control || reply.controllerIdentity !== controllerIdentity) {
      throw new Error('Original native handoff commit bridge differs.');
    }
    const value = captureWorkerFields(reply.value, ['committed', 'stateIntent', 'state'], 'handoff commit value');
    const handoff = Object.freeze({
      attemptId, prepared,
      committed: descriptor(value.committed, `inactive-handoff-${attemptId}-committed.json`),
      stateIntent: descriptor(value.stateIntent, `inactive-handoff-${attemptId}-state-intent.json`),
      state: descriptor(value.state, 'state.json'),
    });
    await assertLockOwner(control, lock);
    scope = await inspectWindowsInactiveTaskHandoff({ taskName, project, pwsh, control, handoff, signal });
    const result = await captureWindowsInactiveTaskHandoffAdmission({ scope, control, lock, admission, handoff, signal });
    return Object.freeze({ scope, lock, handoff, admission: result.admission, sha256: result.sha256 });
  } catch (cause) {
    const errors = [cause];
    try { await scope?.close(); }
    catch (error) { errors.push(error); }
    throw refused(errors.length === 1 ? cause : new AggregateError(errors, 'Update admission and scope cleanup failed.'));
  }
}
