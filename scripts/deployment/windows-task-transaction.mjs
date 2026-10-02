import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertLockOwner, captureLockOwner, validateState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { stopWindowsTask } from './windows-task-controller.mjs';

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
  return stopWindowsTask({ pwsh, admission, sha256, signal,
    transaction: { control: root, lockSha256: digest(lockBytes), stateSha256: digest(stateBytes) },
  });
}
