import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsStoppedRestoreProof } from './windows-stopped-restore-proof.mjs';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';
import { compareWindowsRestoreTaskPolicy } from './windows-restore-task-policy.mjs';
import { inspectSnapshotConfiguration } from './snapshot-configuration.mjs';
import { inspectRecoveryEngineFiles, locateRecoveryEngine } from './recovery-engine-files.mjs';

const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function inspectWindowsStoppedRestoreSnapshot({
  control, project, backup, node, pwsh, admission, proof, profile, signal,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, project, backup, node, pwsh].every(canonical)) {
    throw new Error('Stopped restore snapshot requires explicit canonical native Windows paths.');
  }
  const checkProof = ({ signal: checkSignal = signal } = {}) =>
    assertWindowsStoppedRestoreProof(control, proof, admission, { signal: checkSignal });
  const observation = await checkProof();
  const stateBytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
  const state = parse(stateBytes);
  const original = parse(await readWorkerFile(path.join(control, 'task-maintenance', 'admission.json'),
    1024 * 1024, { privateMode: true }));
  if (digest(stateBytes) !== observation.stateSha256 || state.operationId !== observation.operationId
    || state.project !== project || state.operation !== 'restore'
    || original.operationId !== observation.operationId || original.taskName !== observation.taskName) {
    throw new Error('Stopped restore snapshot differs from the retained original operation.');
  }
  const nativeNode = await realpath(node);
  if (inside(project, nativeNode) || inside(project, await realpath(pwsh))) {
    throw new Error('Stopped restore snapshot requires external native executables.');
  }
  const { root } = await canonicalWorkerDirectory(backup, { privateMode: true });
  const snapshot = await verifySnapshot(root, { signal });
  if (snapshot.id !== state.backupId || snapshot.source.commit !== state.targetCommit
    || snapshot.project !== project || typeof snapshot.recoveryEngine !== 'string') {
    throw new Error('Stopped restore backup differs from the original restore intent.');
  }
  const runtime = await inspectWindowsSnapshotRuntime({
    backup: root, snapshot, project, taskName: observation.taskName, signal,
  });
  if (!canonical(runtime.configuration.command.file) || await realpath(runtime.configuration.command.file) !== nativeNode) {
    throw new Error('Archived stopped restore runtime differs from the explicit Node executable.');
  }
  // Compare the saved task with pre-inhibition policy, not the disabled live task.
  await compareWindowsRestoreTaskPolicy({
    original, task: runtime.task, pwsh, check: checkProof, signal,
  });
  const authorizedPaths = Object.freeze([...new Set(runtime.files
    .map(file => path.join(path.dirname(runtime.task.configuration), file.name))
    .filter(file => !inside(project, file)))].sort());
  if (!same(authorizedPaths, (snapshot.externalFiles ?? []).map(file => file.path).sort())) {
    throw new Error('Stopped restore backup contains foreign external destinations.');
  }
  const configuration = await inspectSnapshotConfiguration({
    backup: root, snapshot, profile, environment: runtime.configuration.command.environment, signal,
  });
  const directory = await locateRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  const engine = await inspectRecoveryEngineFiles({ directory, manifestSha256: snapshot.recoveryEngine, signal });
  if (!engine.manifest.files.some(file => file.name === 'windows-restore-entry.mjs')) {
    throw new Error('Stopped restore backup has no saved Windows restore entry.');
  }
  const recovery = Object.freeze({ directory, manifestSha256: engine.manifestSha256 });
  const check = async ({ signal: checkSignal = signal } = {}) => {
    await checkProof({ signal: checkSignal });
    await runtime.check({ signal: checkSignal });
    await configuration.check({ signal: checkSignal });
    const current = await inspectRecoveryEngineFiles({
      directory, manifestSha256: recovery.manifestSha256, signal: checkSignal,
    });
    if (current.info.dev !== engine.info.dev || current.info.ino !== engine.info.ino) {
      throw new Error('Original stopped restore recovery engine was replaced.');
    }
    await checkProof({ signal: checkSignal });
  };
  await check();
  return Object.freeze({
    mutationAuthority: false, snapshot: structuredClone(snapshot), runtime, recovery,
    providers: configuration.providers, configurationProfile: configuration.profile, authorizedPaths, check,
  });
}
