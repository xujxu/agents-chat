import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner, validateState } from './state.mjs';
import { readWorkerFile } from './worker-files.mjs';
import {
  assertWindowsInactiveTaskAdmissionBinding, captureWindowsInactiveTaskActivationPreparation,
  replaceWindowsInactiveTaskBinding, startWindowsInactiveTaskBinding,
  inspectWindowsInactiveTaskListener,
  prepareWindowsInactiveCompletionBinding, completeWindowsInactiveCompletionBinding,
} from './windows-managed-task.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { rotateSnapshot } from './snapshot-rotation.mjs';
import { validateReadinessProviders } from './http-readiness.mjs';

const transactions = new WeakMap();
const consumers = new WeakSet();
const next = {
  stopped: 'copying', copying: 'rotating', rotating: 'backup-ready',
  'backup-ready': 'source-selected', 'source-selected': 'dependencies', dependencies: 'building',
  building: 'configuring', configuring: 'activating', activating: 'accepted',
};
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
    const retained = { ...originalOptions, observation: initial.observation, snapshot: null, rotating: false, rotated: false };
    const context = Object.freeze({
      async check({ signal: requestSignal } = {}) {
        if (closed) throw new Error('Inactive task transaction is closed.');
        if (failure) throw failure;
        if (busy) throw new Error('Inactive task transaction check is already active.');
        busy = true;
        try {
          const { state } = await readState({ ...originalOptions, signal: requestSignal });
          if (state.sourceCommit !== current.sourceCommit || state.targetCommit !== current.targetCommit
            || state.phase === 'accepted' && !retained.completionPrepared
            || (state.phase === current.phase ? !same(state, current)
              : state.phase !== next[current.phase] || state.previousPhase !== current.phase)
            || (['rotating', 'backup-ready'].includes(state.phase)
              ? !retained.snapshot || state.backupId !== retained.snapshot.id
              : state.backupId !== current.backupId)) {
            throw new Error('Inactive transaction phase or source binding changed.');
          }
          if (state.phase === 'backup-ready' && (!retained.rotated
            || !same(await verifySnapshot(path.join(control, 'backup'), { signal: requestSignal }), retained.snapshot))) {
            throw new Error('Inactive transaction backup differs from its verified rotation.');
          }
          if (state.phase === 'backup-ready'
            && !same((await readState({ ...originalOptions, signal: requestSignal })).state, state)) {
            throw new Error('Inactive transaction state changed during backup verification.');
          }
          current = state;
          return state;
        } catch (error) { failure = error; throw error; }
        finally { busy = false; }
      },
      async listener({ port, signal: requestSignal } = {}) {
        await context.check({ signal: requestSignal });
        if (!retained.active) throw new Error('Inactive listener requires completed guarded startup.');
        const result = await inspectWindowsInactiveTaskListener({ ...retained, port, signal: requestSignal });
        await context.check({ signal: requestSignal });
        return result;
      },
      async prepareCompletion({ port, providers, signal: requestSignal } = {}) {
        validateReadinessProviders(providers);
        if (!retained.active || retained.completing || retained.completionPrepared) {
          throw new Error('Inactive completion requires one original guarded runtime preparation.');
        }
        retained.completing = true;
        try {
          const state = await context.check({ signal: requestSignal });
          if (state.phase !== 'activating') throw new Error('Inactive completion requires original activating state.');
          await prepareWindowsInactiveCompletionBinding({
            ...retained, port, providers: [...providers], state, signal: requestSignal,
          });
          await context.check({ signal: requestSignal });
          retained.completionPrepared = true;
        } finally { retained.completing = false; }
      },
      async complete({ stateSha256, signal: requestSignal } = {}) {
        if (!retained.completionPrepared || retained.completing || retained.completionAttempted
          || typeof stateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stateSha256)) {
          throw new Error('Inactive completion requires original preparation and an explicit accepted state hash.');
        }
        retained.completing = true;
        try {
          const state = await context.check({ signal: requestSignal });
          const bytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
          if (state.phase !== 'accepted' || createHash('sha256').update(bytes).digest('hex') !== stateSha256
            || !same(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), state)) {
            throw new Error('Inactive completion differs from original accepted state.');
          }
          retained.completionAttempted = true;
          const result = await completeWindowsInactiveCompletionBinding({ ...retained, stateSha256, signal: requestSignal });
          await context.check({ signal: requestSignal });
          return result;
        } finally { retained.completing = false; }
      },
      async close() {
        if (busy || retained.rotating || retained.preparing || retained.replacing || retained.starting || retained.completing) {
          throw new Error('Cannot close a busy inactive task transaction.');
        }
        if (!closed) { closed = true; await scope.close(); }
      },
    });
    transactions.set(context, retained);
    return context;
  } catch (error) { consumers.delete(scope); throw error; }
}

export async function retainWindowsInactiveTaskSnapshot({
  context, control, lock, sourceCommit, destination, snapshot, signal,
}) {
  const binding = await assertWindowsInactiveTaskSnapshotStage({ context, control, lock, sourceCommit, signal });
  const retained = transactions.get(context);
  if (retained.snapshot || destination !== path.join(control, 'staging')
    || snapshot?.project !== binding.project || snapshot.source?.commit !== sourceCommit
    || !same(snapshot.runtime, { platform: 'win32', state: 'stopped', task: binding.task })
    || !same(await verifySnapshot(destination, { signal }), snapshot)) {
    throw new Error('Inactive snapshot must match its original verified staging and task binding.');
  }
  await context.check({ signal });
  retained.snapshot = JSON.parse(JSON.stringify(snapshot));
}

export async function rotateWindowsInactiveTaskSnapshot({ context, control, lock: supplied, signal }) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  if (!retained || retained.control !== control || !same(retained.lock, lock) || !retained.snapshot
    || retained.rotating || retained.rotated) {
    throw new Error('Rotation requires the original inactive snapshot transaction.');
  }
  retained.rotating = true;
  try {
    const state = await context.check({ signal });
    if (state.phase !== 'rotating' || state.previousPhase !== 'copying') {
      throw new Error('Inactive snapshot rotation requires its rotating phase.');
    }
    if (!same(await verifySnapshot(path.join(control, 'staging'), { signal }), retained.snapshot)) {
      throw new Error('Inactive staging changed before rotation.');
    }
    await context.check({ signal });
    await rotateSnapshot(control, { project: lock.project });
    if (!same(await verifySnapshot(path.join(control, 'backup'), { signal }), retained.snapshot)) {
      throw new Error('Inactive backup changed during rotation.');
    }
    await context.check({ signal });
    retained.rotated = true;
  } finally { retained.rotating = false; }
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

export async function assertWindowsInactiveTaskSourceStage({
  context, control, lock: supplied, generation, stage, commit: target, signal,
}) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  const phase = { select: 'source-selected', dependencies: 'dependencies', build: 'building' }[stage];
  if (!retained || retained.control !== control || !same(retained.lock, lock)
    || !retained.rotated || !phase || !commit(target)) {
    throw new Error('Source stage requires the original inactive transaction and verified backup.');
  }
  const state = await context.check({ signal });
  if (state.phase !== phase || state.runtimeIdentity !== generation || state.targetCommit !== target
    || state.backupId !== retained.snapshot.id
    || !same(await verifySnapshot(path.join(control, 'backup'), { signal }), retained.snapshot)) {
    throw new Error('Inactive source stage differs from its exact target, phase or retained backup.');
  }
  if (!same(await context.check({ signal }), state)) {
    throw new Error('Inactive source-stage state changed during backup verification.');
  }
}

export async function prepareWindowsInactiveTaskActivation({ context, control, lock: supplied, bundle, signal }) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  if (!retained || retained.control !== control || !same(retained.lock, lock) || !retained.rotated
    || retained.preparing || retained.preparationAttempted
    || !same(bundle, {
      directory: path.join(control, `runtime-${lock.operationId}`),
      configuration: path.join(control, `runtime-${lock.operationId}`, 'configuration.json'),
      sha256: retained.observation.configurationSha256,
    })) {
    throw new Error('Activation preparation requires the original inactive transaction and distinct operation bundle.');
  }
  retained.preparing = true;
  try {
    const state = await context.check({ signal });
    if (state.phase !== 'activating' || state.previousPhase !== 'configuring') {
      throw new Error('Inactive activation preparation requires its activating phase.');
    }
    if (!same(await verifySnapshot(path.join(control, 'backup'), { signal }), retained.snapshot)
      || !same(await context.check({ signal }), state)) {
      throw new Error('Inactive activation backup or state changed.');
    }
    retained.preparationAttempted = true;
    const prepared = await captureWindowsInactiveTaskActivationPreparation({ ...retained, state, signal });
    await context.check({ signal });
    retained.prepared = prepared;
    return prepared;
  } finally { retained.preparing = false; }
}

export async function replaceWindowsInactiveTask({ context, control, lock: supplied, signal }) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  if (!retained || retained.control !== control || !same(retained.lock, lock)
    || !retained.prepared || retained.replacing || retained.replacementAttempted) {
    throw new Error('Inactive replacement requires its original prepared transaction.');
  }
  retained.replacing = true;
  try {
    const state = await context.check({ signal });
    if (state.phase !== 'activating'
      || !same(await verifySnapshot(path.join(control, 'backup'), { signal }), retained.snapshot)
      || !same(await context.check({ signal }), state)) {
      throw new Error('Inactive replacement state or backup changed.');
    }
    retained.replacementAttempted = true;
    const result = await replaceWindowsInactiveTaskBinding({ ...retained, signal });
    await context.check({ signal });
    retained.replaced = result;
    return result;
  } finally { retained.replacing = false; }
}

export async function startWindowsInactiveTask({ context, control, lock: supplied, signal }) {
  const retained = transactions.get(context);
  const lock = captureLockOwner(supplied);
  if (!retained || retained.control !== control || !same(retained.lock, lock)
    || !retained.replaced || retained.starting || retained.startupAttempted) {
    throw new Error('Inactive startup requires its original replaced transaction.');
  }
  retained.starting = true;
  try {
    const state = await context.check({ signal });
    if (state.phase !== 'activating'
      || !same(await verifySnapshot(path.join(control, 'backup'), { signal }), retained.snapshot)
      || !same(await context.check({ signal }), state)) {
      throw new Error('Inactive startup state or backup changed.');
    }
    retained.startupAttempted = true;
    const result = await startWindowsInactiveTaskBinding({ ...retained, signal });
    await context.check({ signal });
    retained.active = result;
    return result;
  } finally { retained.starting = false; }
}
