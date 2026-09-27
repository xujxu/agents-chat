import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { processIdentity } from './process-identity.mjs';

const transitions = {
  preflight: ['stopped', 'source-selected'],
  stopped: ['copying'],
  copying: ['rotating'],
  rotating: ['backup-ready'],
  'backup-ready': ['source-selected'],
  'source-selected': ['dependencies'],
  dependencies: ['building'],
  building: ['configuring'],
  configuring: ['activating'],
  activating: ['accepted', 'activation-unverified'],
  'activation-unverified': ['accepted'],
  'restore-preflight': ['restoring'],
  restoring: ['restore-activating'],
  'restore-activating': ['restored'],
  accepted: [],
  restored: [],
  'recovery-required': [],
  blocked: [],
};

export function nextPhase(from, to, { firstInstall = false } = {}) {
  if (!Object.hasOwn(transitions, from) || !Object.hasOwn(transitions, to)) {
    throw new Error(`Unknown deployment phase: ${from} -> ${to}`);
  }
  const terminal = ['accepted', 'restored', 'recovery-required', 'blocked'].includes(from);
  if (to === 'blocked' && !terminal) return to;
  if (to === 'recovery-required' && !terminal) return to;
  if (!transitions[from].includes(to)
    || (from === 'preflight' && to === 'source-selected' && !firstInstall)) {
    throw new Error(`Invalid deployment transition: ${from} -> ${to}`);
  }
  return to;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/.test(value);
}

export function recoveryAdvice(details) {
  if (!details || !Object.hasOwn(transitions, details.phase)
    || typeof details.backupComplete !== 'boolean' || typeof details.restored !== 'boolean') {
    throw new Error('Invalid deployment recovery state.');
  }
  if (details.phase === 'blocked') {
    if (details.restored || !nonempty(details.diagnosticCommand)) {
      throw new Error('Blocked workers require an explicit inspection command, not restoration.');
    }
    return {
      status: 'blocked',
      message: 'Owned workers may still write. Retain lock and backup; inspect worker termination before restore or restart.',
      command: details.diagnosticCommand, diagnostics: details.diagnosticCommand,
    };
  }
  const status = details.restored ? 'restored'
    : details.backupComplete ? 'recovery-required' : 'no-backup';
  const command = status === 'recovery-required' ? details.restoreCommand : details.retryCommand;
  if (!nonempty(command) || !nonempty(details.diagnosticCommand)) {
    throw new Error('Recovery advice requires explicit next and diagnostic commands.');
  }
  const message = status === 'restored'
    ? `Deployment failed during ${details.phase}; the old application was restored.`
    : status === 'recovery-required'
      ? `Deployment failed during ${details.phase}; the old application was not restored. A complete backup is available.`
      : `Deployment failed during ${details.phase}; no complete backup is available.`;
  return { status, message, command, diagnostics: details.diagnosticCommand };
}

const stateFields = new Set([
  'version', 'operationId', 'project', 'operation', 'phase', 'previousPhase',
  'sourceCommit', 'targetCommit', 'backupId', 'priorRuntime', 'runtimeIdentity',
  'startedAt', 'updatedAt', 'errorCode',
]);

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Invalid deployment state record.');
  }
  if (state.version !== 1) throw new Error('Unsupported deployment state version.');
  if (Object.keys(state).some(key => !stateFields.has(key))) {
    throw new Error('Unexpected field in deployment state.');
  }
  if (Object.keys(state).length !== stateFields.size
    || !nonempty(state.operationId) || !nonempty(state.project) || !path.isAbsolute(state.project)
    || !['deploy', 'update', 'restore'].includes(state.operation)
    || !Object.hasOwn(transitions, state.phase)
    || (state.previousPhase !== null && !Object.hasOwn(transitions, state.previousPhase))
    || !['running', 'stopped', 'absent'].includes(state.priorRuntime)
    || !nonempty(state.runtimeIdentity)
    || ![state.startedAt, state.updatedAt].every(value => nonempty(value) && Number.isFinite(Date.parse(value)))) {
    throw new Error('Invalid or incomplete deployment state.');
  }
  for (const key of ['sourceCommit', 'targetCommit']) {
    if (state[key] !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state[key])) {
      throw new Error(`Invalid deployment state ${key}.`);
    }
  }
  for (const key of ['backupId', 'errorCode']) {
    if (state[key] !== null && (!nonempty(state[key]) || !/^[a-zA-Z0-9_.:-]+$/.test(state[key]))) {
      throw new Error(`Invalid deployment state ${key}.`);
    }
  }
  return state;
}

async function ownedDirectory(root) {
  const resolved = path.resolve(root);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Deployment control path must be a real directory.');
  }
  return resolved;
}

async function readRegularJson(file, label) {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw new Error(`Invalid ${label} file type or size.`);
  }
  const content = await readFile(file, 'utf8');
  try { return JSON.parse(content); }
  catch (cause) { throw new Error(`Malformed ${label}; inspect before continuing.`, { cause }); }
}

export async function loadState(root) {
  const directory = await ownedDirectory(root);
  const state = await readRegularJson(path.join(directory, 'state.json'), 'deployment state');
  return state === null ? null : validateState(state);
}

export async function writeState(root, state) {
  validateState(state);
  const directory = await ownedDirectory(root);
  const destination = path.join(directory, 'state.json');
  const old = await readRegularJson(destination, 'deployment state');
  if (old !== null) {
    validateState(old);
    if (old.phase === 'blocked') {
      throw new Error('Deployment is blocked by unsettled workers; establish termination before changing state.');
    }
    if (old.project !== state.project) throw new Error('Deployment state project changed.');
    if (old.operationId === state.operationId) {
      if (old.operation !== state.operation || state.previousPhase !== old.phase) {
        throw new Error('Invalid deployment state transition identity.');
      }
      nextPhase(old.phase, state.phase, { firstInstall: old.priorRuntime === 'absent' });
    } else if (state.previousPhase !== null
      || (state.operation === 'restore'
        ? state.phase !== 'restore-preflight'
        : state.phase !== 'preflight' || !['accepted', 'restored'].includes(old.phase))) {
      throw new Error('Unfinished deployment state requires recovery before a new operation.');
    }
  } else if (state.previousPhase !== null
    || state.phase !== (state.operation === 'restore' ? 'restore-preflight' : 'preflight')) {
    throw new Error('Initial deployment state requires a preflight phase.');
  }
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, destination);
  } catch (error) {
    if (!closed) await handle.close();
    try { await unlink(temporary); }
    catch (cleanup) {
      if (cleanup.code !== 'ENOENT') {
        throw new AggregateError([error, cleanup], 'State write and temporary-file cleanup failed.');
      }
    }
    throw error;
  }
}

export async function acquireLock(root, { project, operationId }) {
  if (!nonempty(project) || !nonempty(operationId)) throw new Error('Invalid lock owner.');
  const directory = await ownedDirectory(root);
  const canonicalProject = await realpath(project);
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('Cannot establish deployment lock owner identity.');
  const lockPath = path.join(directory, 'lock');
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Deployment lock exists. Inspect the operation and owned processes before recovery; no lock was removed.', { cause: error });
    }
    throw error;
  }
  const owner = {
    version: 1, token: randomUUID(), project: canonicalProject, operationId,
    pid: process.pid, processIdentity: identity, createdAt: new Date().toISOString(),
  };
  const ownerPath = path.join(lockPath, 'owner.json');
  let handle;
  try {
    handle = await open(ownerPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  // Even an incomplete owner file leaves a lock requiring inspection.
  return owner;
}

export async function releaseLock(root, owner) {
  const directory = await ownedDirectory(root);
  if ((await loadState(directory))?.phase === 'blocked') {
    throw new Error('Blocked deployment workers require retaining the lock.');
  }
  const lockPath = path.join(directory, 'lock');
  await ownedDirectory(lockPath);
  const ownerPath = path.join(lockPath, 'owner.json');
  const actual = await readRegularJson(ownerPath, 'deployment lock owner');
  if (!actual || !owner || actual.token !== owner.token || actual.operationId !== owner.operationId
    || actual.project !== owner.project || actual.pid !== process.pid || owner.pid !== process.pid
    || actual.processIdentity !== owner.processIdentity
    || actual.processIdentity !== await processIdentity(process.pid)) {
    throw new Error('Only the current lock owner can release a deployment lock.');
  }
  await unlink(ownerPath);
  await rmdir(lockPath);
}

export async function reconcileInterruptedOperation(root) {
  const directory = await ownedDirectory(root);
  const state = await loadState(directory);
  if (state?.phase === 'blocked') {
    return {
      status: 'blocked', operationId: state.operationId, phase: state.phase,
      message: 'Worker settlement was not confirmed. Retain lock and backup; inspect owned workers before recovery.',
    };
  }
  const lockPath = path.join(directory, 'lock');
  let lockExists = true;
  try { await ownedDirectory(lockPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    lockExists = false;
  }
  if (lockExists) {
    const owner = await readRegularJson(path.join(lockPath, 'owner.json'), 'deployment lock owner');
    if (owner !== null) {
      if (owner.version !== 1 || !nonempty(owner.processIdentity)
        || !nonempty(owner.operationId) || !nonempty(owner.project) || !nonempty(owner.token)) {
        throw new Error('Invalid deployment lock owner; inspect before continuing.');
      }
      const identity = await processIdentity(owner.pid);
      if (identity !== null && identity === owner.processIdentity) {
        return { status: 'active', operationId: owner.operationId, phase: state?.phase ?? null,
          message: 'Another deployment process owns this operation. Wait for it to finish.' };
      }
    }
    return { status: 'interrupted', operationId: owner?.operationId ?? state?.operationId ?? null,
      phase: state?.phase ?? null,
      message: 'Interrupted deployment lock retained. Inspect owned child processes and recovery state before continuing.' };
  }
  if (state !== null && !['accepted', 'restored'].includes(state.phase)) {
    return { status: state.phase === 'activation-unverified' ? 'unverified' : 'interrupted',
      operationId: state.operationId, phase: state.phase,
      message: 'Inspect the incomplete deployment and use its verification or recovery command before another update.' };
  }
  return { status: 'idle', operationId: state?.operationId ?? null, phase: state?.phase ?? null,
    message: 'No interrupted deployment operation recorded.' };
}
