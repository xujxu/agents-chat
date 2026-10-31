import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertLockOwner, captureLockOwner, validateState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { stopWindowsTask } from './windows-task-controller.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

const transactions = new WeakMap();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

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
  const context = await stopWindowsTask({ pwsh, admission, sha256, signal,
    transaction: { control: root, lockSha256: digest(lockBytes), stateSha256: digest(stateBytes) },
  });
  transactions.set(context, { control: root, lock, state, admission, sha256 });
  return context;
}

export async function assertWindowsTaskSnapshotStage({ context, control, lock: suppliedLock, sourceCommit, signal }) {
  signal?.throwIfAborted();
  const retained = transactions.get(context);
  const lock = captureLockOwner(suppliedLock);
  if (!retained || retained.control !== control || !isDeepStrictEqual(retained.lock, lock)
    || typeof sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) {
    throw new Error('Snapshot requires the original retained copying-stage task transaction.');
  }
  await assertLockOwner(control, lock);
  const statePath = path.join(control, 'state.json');
  const bytes = await readWorkerFile(statePath, 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (state.operation === 'restore' || state.operation !== retained.state.operation
    || state.project !== lock.project || state.operationId !== lock.operationId || state.startedAt !== lock.createdAt
    || state.priorRuntime !== 'running' || state.runtimeIdentity !== retained.state.runtimeIdentity
    || state.sourceCommit !== retained.state.sourceCommit || state.sourceCommit !== sourceCommit
    || state.targetCommit !== retained.state.targetCommit || state.phase !== 'copying'
    || state.previousPhase !== 'stopped' || state.errorCode !== null) {
    throw new Error('Snapshot requires unchanged original task state in its copying stage.');
  }
  const admissionBytes = await readWorkerFile(retained.admission, 1024 * 1024, { privateMode: true });
  if (digest(admissionBytes) !== retained.sha256) throw new Error('Original snapshot task admission changed.');
  const native = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(admissionBytes)), [
    'version', 'operationId', 'controllerPid', 'controllerIdentity', 'taskName', 'definition', 'securityDescriptor',
    'configuration', 'configurationSha256', 'readySha256', 'ownerPid', 'ownerIdentity', 'generation', 'instanceGuid',
  ], 'original snapshot task admission');
  if (native.version !== 1 || native.operationId !== lock.operationId
    || native.controllerPid !== lock.pid || native.controllerIdentity !== lock.processIdentity
    || native.generation !== state.runtimeIdentity
    || typeof native.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(native.taskName)
    || typeof native.definition !== 'string' || !native.definition || native.definition.length > 262144 || native.definition.includes('\0')
    || typeof native.securityDescriptor !== 'string' || !native.securityDescriptor
    || native.securityDescriptor.length > 65536 || /[\0\r\n]/.test(native.securityDescriptor)
    || typeof native.configuration !== 'string' || !path.isAbsolute(native.configuration)
    || path.resolve(native.configuration) !== native.configuration || /[\0\r\n]/.test(native.configuration)
    || path.basename(native.configuration) !== 'configuration.json'
    || typeof native.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(native.configurationSha256)) {
    throw new Error('Original snapshot task metadata differs from its retained transaction.');
  }
  await context.check({ signal });
  if (!(await readWorkerFile(statePath, 65536, { privateMode: true })).equals(bytes)
    || !(await readWorkerFile(retained.admission, 1024 * 1024, { privateMode: true })).equals(admissionBytes)) {
    throw new Error('Original snapshot authority changed during native verification.');
  }
  await assertLockOwner(control, lock);
  signal?.throwIfAborted();
  return Object.freeze({ project: lock.project, sourceCommit, task: Object.freeze({
    version: 1, name: native.taskName, definition: native.definition, securityDescriptor: native.securityDescriptor,
    configuration: native.configuration, configurationSha256: native.configurationSha256,
  }) });
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
