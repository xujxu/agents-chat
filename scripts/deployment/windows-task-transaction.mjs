import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertLockOwner, captureLockOwner, validateState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { stopWindowsTask } from './windows-task-controller.mjs';

const transactions = new WeakMap();

export async function stopWindowsTaskTransaction({ control, lock: suppliedLock, pwsh, admission, sha256, signal }) {
  signal?.throwIfAborted();
  const lock = captureLockOwner(suppliedLock);
  const { root } = await externalWorkerDirectory(control, lock.project);
  if (admission !== path.join(root, 'task-maintenance', 'admission.json')) {
    throw new Error('Task transaction requires its original control admission path.');
  }
  await assertLockOwner(root, lock);
  const lockBytes = await readWorkerFile(path.join(root, 'lock', 'owner.json'), 65536, { privateMode: true });
  const capturedLock = captureLockOwner(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes)));
  if (Object.keys(lock).some(key => capturedLock[key] !== lock[key])) throw new Error('Original task lock changed.');
  const stateBytes = await readWorkerFile(path.join(root, 'state.json'), 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes)));
  if (state.project !== lock.project || state.operationId !== lock.operationId
    || state.startedAt !== lock.createdAt || state.priorRuntime !== 'running' || state.errorCode !== null
    || state.phase !== (state.operation === 'restore' ? 'restoring' : 'stopped')) {
    throw new Error('Native task stop requires a matching stopped-phase transaction.');
  }
  await assertLockOwner(root, lock);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const context = await stopWindowsTask({ pwsh, admission, sha256, signal,
    transaction: { control: root, lockSha256: digest(lockBytes), stateSha256: digest(stateBytes) },
  });
  transactions.set(context, { control: root, lock, state });
  return context;
}

export async function assertWindowsTaskSourceStage({ context, control, lock: suppliedLock, generation, stage, commit, signal }) {
  signal?.throwIfAborted();
  const retained = transactions.get(context);
  const lock = captureLockOwner(suppliedLock);
  const phase = { select: 'source-selected', dependencies: 'dependencies', build: 'building' }[stage];
  if (!retained || retained.control !== control || !isDeepStrictEqual(retained.lock, lock) || !phase
    || typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error('Source mutation requires the original retained task transaction and an explicit stage/commit.');
  }
  await assertLockOwner(control, lock);
  const statePath = path.join(control, 'state.json');
  const bytes = await readWorkerFile(statePath, 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (state.operation === 'restore' || state.operation !== retained.state.operation
    || state.project !== lock.project || state.operationId !== lock.operationId || state.startedAt !== lock.createdAt
    || state.priorRuntime !== 'running' || state.runtimeIdentity !== retained.state.runtimeIdentity
    || state.runtimeIdentity !== generation
    || state.sourceCommit !== retained.state.sourceCommit || state.targetCommit !== retained.state.targetCommit
    || state.targetCommit !== commit || state.phase !== phase || state.errorCode !== null) {
    throw new Error('Source mutation requires matching original task state in its designated phase.');
  }
  await context.check({ signal });
  if (!(await readWorkerFile(statePath, 65536, { privateMode: true })).equals(bytes)) {
    throw new Error('Task source-stage state changed during native verification.');
  }
  await assertLockOwner(control, lock);
}
