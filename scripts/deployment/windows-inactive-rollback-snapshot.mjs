import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsInactiveLostRuntimeAuthority } from './windows-task-completion-recovery.mjs';
import { readWorkerFile, canonicalWorkerDirectory } from './worker-files.mjs';
import { validateState } from './state.mjs';
import { verifySnapshot } from './snapshot.mjs';

export async function inspectWindowsInactiveRollbackSnapshot(options) {
  const { control, signal } = options;
  const observed = await assertWindowsInactiveLostRuntimeAuthority(options);
  const stateFile = path.join(control, 'state.json');
  const stateBytes = await readWorkerFile(stateFile, 65536, { privateMode: true });
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
  const check = async ({ signal: checkSignal = signal } = {}) => {
    await assertWindowsInactiveLostRuntimeAuthority({ ...options, signal: checkSignal });
    const currentDirectory = await canonicalWorkerDirectory(backup, { privateMode: true });
    if (currentDirectory.info.dev !== directory.info.dev || currentDirectory.info.ino !== directory.info.ino) {
      throw new Error('Original inactive rollback backup directory was replaced.');
    }
    if (!(await readWorkerFile(stateFile, 65536, { privateMode: true })).equals(stateBytes)
      || !same(await verifySnapshot(backup, { signal: checkSignal }), retained)) {
      throw new Error('Inactive rollback state or verified snapshot changed.');
    }
    await assertWindowsInactiveLostRuntimeAuthority({ ...options, signal: checkSignal });
  };
  await check();
  return Object.freeze({ mutationAuthority: false, snapshot: structuredClone(retained), check });
}
