import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';
import { inspectWindowsInactiveRollbackSnapshot } from './windows-inactive-rollback-snapshot.mjs';
import { verifyWindowsInactiveRollbackFiles } from './windows-inactive-rollback-files.mjs';
export { inspectWindowsInactiveRollbackSnapshot } from './windows-inactive-rollback-snapshot.mjs';
export { restoreWindowsInactiveRollbackProject } from './windows-inactive-rollback-project.mjs';
export { restoreWindowsInactiveRollbackExternal } from './windows-inactive-rollback-external.mjs';

const lostScopes = new WeakMap();
export const openWindowsInactiveRollbackRetirement = options => openCompletionRecovery(options, true, false, true);
export async function prepareWindowsInactiveRollbackRetirementIntent(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Rollback retirement requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  const verified = await verifyWindowsInactiveRollbackFiles({ ...options, terminalPublication: true });
  const result = await lostScopes.get(options.scope).request('prepare-rollback-retirement', options.signal);
  await verified.check();
  return result;
}
export async function prepareWindowsInactiveRollbackCompletionReceipt(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Rollback completion requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  const verified = await verifyWindowsInactiveRollbackFiles({ ...options, terminalPublication: true });
  const result = await lostScopes.get(options.scope).request('complete-rollback', options.signal);
  await verified.check();
  return result;
}
export async function publishWindowsInactiveRollbackTerminalState(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Terminal publication requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  const verified = await verifyWindowsInactiveRollbackFiles({ ...options, terminalPublication: true });
  const result = await lostScopes.get(options.scope).request('publish-rollback-state', options.signal);
  await verified.check();
  return result;
}
export async function stageWindowsInactiveRollbackTerminalState(options) {
  await prepareWindowsInactiveRollbackTerminalIntent(options);
  const verified = await verifyWindowsInactiveRollbackFiles(options);
  const result = await lostScopes.get(options.scope).request('stage-rollback-state', options.signal);
  await verified.check();
  return result;
}
export async function prepareWindowsInactiveRollbackTerminalIntent(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Terminal handoff requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  const verified = await verifyWindowsInactiveRollbackFiles(options);
  const result = await lostScopes.get(options.scope).request('prepare-rollback-terminal', options.signal);
  await verified.check();
  return result;
}
export async function restoreWindowsInactiveRollbackTask(options) {
  return restoreInactiveRollbackTask(options, 'restore-rollback-task');
}
export async function advanceWindowsInactiveRollbackTask(options) {
  return restoreInactiveRollbackTask(options, 'advance-rollback-task');
}
async function restoreInactiveRollbackTask(options, method) {
  await prepareWindowsInactiveRollbackFilesReceipt(options);
  const verified = await verifyWindowsInactiveRollbackFiles(options);
  const result = await lostScopes.get(options.scope).request(method, options.signal);
  await verified.check();
  return result;
}
export async function prepareWindowsInactiveRollbackFilesReceipt(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Rollback receipt requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  await prepareWindowsInactiveRollbackIntent(options);
  const verified = await verifyWindowsInactiveRollbackFiles(options);
  const result = await lostScopes.get(options.scope).request('rollback-files-restored', options.signal);
  await verified.check();
  return result;
}
export async function prepareWindowsInactiveRollbackIntent(options) {
  if (options.acceptDataLoss !== true) throw refused(new Error('Rollback requires explicit data-loss acknowledgement.'));
  await assertWindowsInactiveLostRuntimeAuthority(options);
  const binding = await inspectWindowsInactiveRollbackSnapshot(options);
  await binding.check();
  const result = await lostScopes.get(options.scope).request('prepare-rollback', options.signal);
  await binding.check();
  return result;
}
export async function assertWindowsInactiveLostRuntimeAuthority({ control, pwsh, admission, scope, signal }) {
  const retained = lostScopes.get(scope);
  if (!retained || retained.control !== control || retained.pwsh !== pwsh || retained.admission !== admission) {
    throw refused(new Error('Original owned lost-runtime scope is required.'));
  }
  return scope.check({ signal });
}

const script = fileURLToPath(new URL('./windows-task-completion-recovery-controller.ps1', import.meta.url));
const steps = Object.freeze([
  'release-requested', 'released', 'policy-restore-requested', 'permanent-policy-applied',
  'policy-restored', 'enable-requested', 'enable-applied', 'complete',
]);
const durablePhase = step => ({
  'permanent-policy-applied': 'policy-restore-requested', 'enable-applied': 'enable-requested',
})[step] ?? step;
function refused(cause) {
  return Object.assign(new Error('Completion recovery refused; retain original operation evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED', recoveryAllowed: false,
  });
}
function capture(value, progression) {
  const record = captureWorkerFields(value, [
    'status', 'phase', 'step', 'operationId', 'taskName', 'stateSha256',
    'completionSha256', 'runtime', 'port', 'providers', 'lease',
  ], 'completion recovery');
  const { status, phase, step, ...fields } = record;
  if (!progression.includes(step) || phase !== durablePhase(step)
    || status !== (phase === 'complete' ? 'complete' : 'pending')) {
    throw new Error('Invalid completion recovery progress.');
  }
  const common = captureWindowsTaskCompletionProof({ ...fields, status: 'observed', mutationAuthority: false });
  return Object.freeze({ ...record, runtime: common.runtime, providers: common.providers });
}
function identityFields({ status, phase, step, completionSha256, ...fields }) { return fields; }

function captureLostRuntime(value) {
  const record = captureWorkerFields(value, [
    'status', 'mutationAuthority', 'phase', 'operationId', 'taskName', 'priorRuntime',
    'stateSha256', 'completionSha256', 'runtime',
  ], 'inactive lost-runtime evidence');
  if (record.status !== 'inactive-runtime-lost' || record.mutationAuthority !== false
    || record.phase !== 'release-requested' || record.priorRuntime !== 'stopped'
    || typeof record.operationId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.operationId)
    || record.operationId === '00000000-0000-0000-0000-000000000000'
    || typeof record.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(record.taskName)
    || ![record.stateSha256, record.completionSha256].every(hash =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid inactive lost-runtime observation.');
  }
  return Object.freeze({ ...record, runtime: captureActivatedRuntime(record.runtime) });
}

export const openWindowsTaskCompletionRecovery = options => openCompletionRecovery(options, false);
export const openWindowsInactiveTaskCompletionRecovery = options => openCompletionRecovery(options, true);
export const openWindowsInactiveLostRuntimeAuthority = options => openCompletionRecovery(options, true, true);

function captureStoppedRetirement(value) {
  const result = captureWorkerFields(value,
    ['status', 'operationId', 'stateSha256', 'completionSha256', 'retiredEntries', 'totalEntries'],
    'stopped rollback retirement');
  if (result.status !== 'retiring' || typeof result.operationId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.operationId)
    || !Number.isSafeInteger(result.totalEntries) || result.totalEntries < 1
    || !Number.isSafeInteger(result.retiredEntries) || result.retiredEntries < 0
    || result.retiredEntries > result.totalEntries
    || ![result.stateSha256, result.completionSha256].every(hash =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid stopped rollback retirement progress.');
  }
  return Object.freeze(result);
}

async function openCompletionRecovery({ control, pwsh, admission, signal }, inactive, lost = false, retirement = false) {
  const progression = inactive
    ? ['release-requested', 'released', 'policy-restore-requested', 'permanent-policy-applied', 'complete']
    : steps;
  const captureObservation = value => retirement ? captureStoppedRetirement(value)
    : lost ? captureLostRuntime(value) : capture(value, progression);
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original recovery actor identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native completion recovery controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity,
      ...(inactive ? ['-Inactive'] : []), ...(lost ? ['-LostRuntime'] : []),
      ...(retirement ? ['-StoppedRetirement'] : [])],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'completion recovery readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original completion recovery bridge differs.');
    }
    let observation = captureObservation(ready.value);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const exchange = async (method, requestSignal) => {
      const id = ++sequence;
      await wire.send({ id, method });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
        ['id', 'type', 'value', 'processIdentity'], 'completion recovery reply');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
        throw new Error('Unexpected completion recovery acknowledgement.');
      }
      if (method === 'close') {
        if (reply.value !== 'close') throw new Error('Unexpected completion recovery close acknowledgement.');
        return;
      }
      if (retirement) {
        if (method === 'prepare-stopped-workers') {
          const prepared = captureWorkerFields(reply.value, ['file', 'sha256'], 'stopped worker retirement checkpoint');
          if (prepared.file !== path.join(control, 'inactive-rollback-workers.json')
            || typeof prepared.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.sha256)) {
            throw new Error('Invalid stopped worker retirement checkpoint acknowledgement.');
          }
          return Object.freeze(prepared);
        }
        const next = captureStoppedRetirement(reply.value);
        const expected = method === 'advance'
          ? { ...observation, retiredEntries: Math.min(observation.retiredEntries + 1, observation.totalEntries) }
          : observation;
        if (!isDeepStrictEqual(next, expected)) throw new Error('Stopped cleanup changed bindings or skipped a prefix.');
        observation = next;
        return next;
      }
      if (method === 'check-rollback-retirement') {
        const result = captureWorkerFields(reply.value,
          ['status', 'operationId', 'stateSha256', 'completionSha256', 'retiredEntries', 'totalEntries'],
          'inactive rollback retirement admission');
        if (!lost || result.status !== 'retiring' || result.operationId !== observation.operationId
          || result.retiredEntries !== 0 || !Number.isSafeInteger(result.totalEntries) || result.totalEntries < 1
          || ![result.stateSha256, result.completionSha256].every(value =>
            typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
          throw new Error('Invalid intact stopped retirement acknowledgement.');
        }
        return Object.freeze(result);
      }
      if (method === 'prepare-rollback-retirement') {
        const result = captureWorkerFields(reply.value, ['file', 'sha256'], 'inactive rollback retirement intent');
        if (!lost || result.file !== path.join(control, 'inactive-rollback-retirement.json')
          || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
          throw new Error('Invalid inactive rollback retirement acknowledgement.');
        }
        return Object.freeze(result);
      }
      if (method === 'complete-rollback') {
        const result = captureWorkerFields(reply.value, ['status', 'file', 'sha256'], 'inactive rollback completion receipt');
        if (!lost || result.status !== 'inactive-rollback-complete'
          || result.file !== path.join(control, 'inactive-rollback-complete.json')
          || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
          throw new Error('Invalid inactive rollback completion acknowledgement.');
        }
        return Object.freeze(result);
      }
      if (method === 'stage-rollback-state' || method === 'publish-rollback-state') {
        const published = method === 'publish-rollback-state';
        const result = captureWorkerFields(reply.value, ['status', 'file', 'sha256'], 'inactive staged terminal state');
        if (!lost || result.status !== (published ? 'inactive-terminal-state-published' : 'inactive-terminal-state-staged')
          || result.file !== path.join(control, published ? 'state.json' : 'state.json.lock')
          || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
          throw new Error('Invalid inactive terminal staging acknowledgement.');
        }
        return Object.freeze(result);
      }
      if (method === 'advance-rollback-task') {
        const result = captureWorkerFields(reply.value, ['step'], 'inactive rollback task advancement');
        if (!lost || !['task-restore-requested', 'task-registered', 'task-restored'].includes(result.step)) {
          throw new Error('Invalid inactive rollback task advancement.');
        }
        return Object.freeze(result);
      }
      if (method === 'restore-rollback-task') {
        const result = captureWorkerFields(reply.value,
          ['status', 'taskName', 'priorRuntime', 'file', 'sha256'], 'inactive rollback task receipt');
        if (!lost || result.status !== 'task-restored' || result.taskName !== observation.taskName
          || result.priorRuntime !== 'stopped'
          || result.file !== path.join(control, 'inactive-rollback-task-restored.json')
          || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
          throw new Error('Invalid inactive rollback task acknowledgement.');
        }
        return Object.freeze(result);
      }
      if (method === 'prepare-rollback' || method === 'rollback-files-restored' || method === 'prepare-rollback-terminal') {
        const result = captureWorkerFields(reply.value, ['file', 'sha256'], 'inactive rollback intent');
        const name = method === 'prepare-rollback' ? 'inactive-rollback-intent.json'
          : method === 'rollback-files-restored' ? 'inactive-rollback-files-restored.json' : 'inactive-rollback-terminal.json';
        if (!lost || result.file !== path.join(control, name)
          || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
          throw new Error('Invalid inactive rollback intent acknowledgement.');
        }
        return Object.freeze(result);
      }
      const next = captureObservation(reply.value);
      if (method === 'check') {
        if (!isDeepStrictEqual(next, observation)) throw new Error('Retained completion recovery evidence changed.');
      } else {
        const index = progression.indexOf(observation.step);
        if (next.step !== progression[Math.min(index + 1, progression.length - 1)]
          || !isDeepStrictEqual(identityFields(next), identityFields(observation))
          || (next.phase === observation.phase) !== (next.completionSha256 === observation.completionSha256)) {
          throw new Error('Completion recovery changed original identity or skipped a step.');
        }
      }
      observation = next;
      return next;
    };
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A completion recovery request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Completion recovery is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original recovery bridge exited.');
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method === 'advance' && !retirement) {
          await exchange('check', requestSignal);
          await verifyHttpReadiness({ port: observation.port, providers: observation.providers, signal: requestSignal });
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        const result = await exchange(method, requestSignal);
        if (method === 'close') {
          const exited = await waitForExit();
          if (exited.code !== 0 || exited.signal !== null) throw new Error('Completion recovery bridge did not close cleanly.');
          closed = true;
          wire.close();
        } else {
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
        }
        return result;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    const scope = Object.freeze({
      identity,
      get observation() { return observation; },
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      ...(retirement ? {
        prepareWorkers: ({ signal: requestSignal } = {}) => request('prepare-stopped-workers', requestSignal),
      } : {}),
      ...(lost ? {} : { advance: ({ signal: requestSignal } = {}) => request('advance', requestSignal) }),
      close: async () => { if (!closed) await request('close'); },
    });
    if (lost) lostScopes.set(scope, { control, pwsh, admission, request });
    return scope;
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
