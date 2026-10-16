import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner, validateState } from './state.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { assertWindowsInactiveTaskAdmissionBinding } from './windows-managed-task.mjs';

const transactions = new WeakMap();
const consumers = new WeakSet();
const next = { stopped: 'copying', copying: 'rotating', rotating: 'backup-ready' };
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

async function readState(options) {
  const file = path.join(options.control, 'state.json');
  const bytes = await readWorkerFile(file, 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const binding = await assertWindowsInactiveTaskAdmissionBinding(options);
  if (!(await readWorkerFile(file, 65536, { privateMode: true })).equals(bytes)) {
    throw new Error('Inactive transaction state changed during native verification.');
  }
  const original = binding.state;
  if (state.phase === 'preflight') {
    throw new Error('Inactive admission requires a matching stopped-phase transaction.');
  }
  if (state.project !== original.project || state.operationId !== original.operationId
    || state.operation !== original.operation || state.startedAt !== original.startedAt
    || state.runtimeIdentity !== original.runtimeIdentity || state.priorRuntime !== 'stopped'
    || state.errorCode !== null || !commit(state.sourceCommit) || !commit(state.targetCommit)
    || original.sourceCommit !== null && state.sourceCommit !== original.sourceCommit
    || original.targetCommit !== null && state.targetCommit !== original.targetCommit) {
    throw new Error('Inactive transaction differs from its original stopped admission.');
  }
  return { state: Object.freeze({ ...state }), observation: binding.observation };
}

export async function beginWindowsInactiveTaskTransaction(options) {
  const { scope, control, admission, sha256, signal } = options;
  if (!scope || typeof scope !== 'object' || consumers.has(scope)) {
    throw new Error('Inactive observation already has a transaction consumer or is invalid.');
  }
  const lock = captureLockOwner(options.lock);
  const originalOptions = Object.freeze({ scope, control, lock, admission, sha256 });
  consumers.add(scope);
  try {
    const initial = await readState({ ...originalOptions, signal });
    if (initial.state.phase !== 'stopped' || initial.state.previousPhase !== 'preflight') {
      throw new Error('Inactive admission requires a matching stopped-phase transaction.');
    }
    let current = initial.state;
    let closed = false;
    let busy = false;
    let failure;
    const context = Object.freeze({
      async check({ signal: requestSignal } = {}) {
        if (closed) throw new Error('Inactive task transaction is closed.');
        if (failure) throw failure;
        if (busy) throw new Error('Inactive task transaction check is already active.');
        busy = true;
        try {
          const { state } = await readState({ ...originalOptions, signal: requestSignal });
          if (state.sourceCommit !== current.sourceCommit || state.targetCommit !== current.targetCommit
            || (state.phase === current.phase ? !same(state, current)
              : state.phase !== next[current.phase] || state.previousPhase !== current.phase)
            || state.phase !== 'backup-ready' && state.backupId !== current.backupId) {
            throw new Error('Inactive transaction phase or source binding changed.');
          }
          current = state;
          return state;
        } catch (error) { failure = error; throw error; }
        finally { busy = false; }
      },
      async close() {
        if (busy) throw new Error('Cannot close a busy inactive task transaction.');
        if (!closed) { closed = true; await scope.close(); }
      },
    });
    transactions.set(context, { ...originalOptions, observation: initial.observation });
    return context;
  } catch (error) { consumers.delete(scope); throw error; }
}

export async function assertWindowsInactiveTaskSnapshotStage({ context, control, lock: supplied, sourceCommit, signal }) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  if (!retained || retained.control !== control || !same(retained.lock, lock) || !commit(sourceCommit)) {
    throw new Error('Snapshot requires the original inactive copying-stage transaction.');
  }
  const state = await context.check({ signal });
  if (state.phase !== 'copying' || state.previousPhase !== 'stopped' || state.sourceCommit !== sourceCommit) {
    throw new Error('Snapshot requires the original inactive source in its copying stage.');
  }
  const original = retained.observation;
  return Object.freeze({ project: lock.project, sourceCommit, task: Object.freeze({
    version: 1, name: original.taskName, definition: original.definition,
    securityDescriptor: original.securityDescriptor, configuration: original.configuration,
    configurationSha256: original.configurationSha256,
  }) });
}
