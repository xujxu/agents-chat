import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsInactiveLostRuntimeAuthority } from './windows-task-completion-recovery.mjs';
import { readWorkerFile, canonicalWorkerDirectory } from './worker-files.mjs';
import { validateState } from './state.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';

async function readInactiveRollbackState(control, terminalPublication) {
  const physical = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
  if (!terminalPublication) return physical;
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const terminalBytes = await readWorkerFile(path.join(control, 'inactive-rollback-terminal.json'),
    1048576, { privateMode: true });
  const terminal = JSON.parse(decode(terminalBytes));
  const intent = JSON.parse(decode(await readWorkerFile(
    path.join(control, 'inactive-rollback-state-intent.json'), 262144, { privateMode: true })));
  if (typeof terminal.oldState !== 'string' || typeof intent.nextState !== 'string'
    || intent.oldState !== terminal.oldState
    || intent.terminalSha256 !== createHash('sha256').update(terminalBytes).digest('hex')
    || ![terminal.oldState, intent.nextState].includes(decode(physical))) {
    throw new Error('Inactive terminal publication differs from its retained original state proposal.');
  }
  return Buffer.from(terminal.oldState, 'utf8');
}

export async function inspectWindowsInactiveRollbackSnapshot(options) {
  const { control, signal } = options;
  const observed = await assertWindowsInactiveLostRuntimeAuthority(options);
  const stateBytes = await readInactiveRollbackState(control, options.terminalPublication === true);
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes)));
  if (createHash('sha256').update(stateBytes).digest('hex') !== observed.stateSha256
    || state.operationId !== observed.operationId || state.operation !== 'update'
    || state.phase !== 'accepted' || state.priorRuntime !== 'stopped') {
    throw new Error('Inactive rollback snapshot requires its original accepted update state.');
  }
  const original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    await readWorkerFile(path.join(control, 'task-maintenance/admission.json'), 1048576, { privateMode: true })));
  if (original.version !== 2 || original.kind !== 'inactive'
    || original.operationId !== observed.operationId || original.taskName !== observed.taskName) {
    throw new Error('Inactive rollback admission differs from retained original history.');
  }
  const task = {
    version: 1, name: original.taskName, definition: original.definition,
    securityDescriptor: original.securityDescriptor, configuration: original.configuration,
    configurationSha256: original.configurationSha256,
  };
  const backup = path.join(control, 'backup');
  const directory = await canonicalWorkerDirectory(backup, { privateMode: true });
  const snapshot = await verifySnapshot(directory.root, { signal });
  if (snapshot.id !== state.backupId || snapshot.project !== state.project
    || snapshot.source.commit !== state.sourceCommit
    || !same(snapshot.runtime, { platform: 'win32', state: 'stopped', task })) {
    throw new Error('Inactive rollback backup differs from its original source or stopped task.');
  }
  const retained = structuredClone(snapshot);
  const runtime = await inspectWindowsSnapshotRuntime({
    backup, snapshot: retained, project: state.project, taskName: observed.taskName, signal,
  });
  const authorizedPaths = Object.freeze([...new Set(runtime.files.map(file =>
    path.join(path.dirname(runtime.task.configuration), file.name)).filter(file => {
    const relative = path.relative(state.project, file);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }))].sort());
  if (!same(authorizedPaths, (retained.externalFiles ?? []).map(file => file.path).sort())) {
    throw new Error('Inactive rollback snapshot contains foreign external destinations.');
  }
  const check = async ({ signal: checkSignal = signal } = {}) => {
    await assertWindowsInactiveLostRuntimeAuthority({ ...options, signal: checkSignal });
    const currentDirectory = await canonicalWorkerDirectory(backup, { privateMode: true });
    if (currentDirectory.info.dev !== directory.info.dev || currentDirectory.info.ino !== directory.info.ino) {
      throw new Error('Original inactive rollback backup directory was replaced.');
    }
    if (!(await readInactiveRollbackState(control, options.terminalPublication === true)).equals(stateBytes)
      || !same(await verifySnapshot(backup, { signal: checkSignal }), retained)) {
      throw new Error('Inactive rollback state or verified snapshot changed.');
    }
    await runtime.check({ signal: checkSignal });
    await assertWindowsInactiveLostRuntimeAuthority({ ...options, signal: checkSignal });
  };
  await check();
  return Object.freeze({ mutationAuthority: false, snapshot: structuredClone(retained), runtime, authorizedPaths, check });
}
