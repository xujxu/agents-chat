import { assertWindowsColdRestoreLease } from './windows-cold-restore-lease.mjs';
import { prepareWindowsColdRestoreRuntimeBundle } from './windows-cold-restore-runtime.mjs';
import { restoreProjectSnapshot } from './restore-project.mjs';
import { restoreExternalSnapshot } from './restore-external.mjs';
import { runStage } from './stage-runner.mjs';

export async function restoreWindowsColdFiles({
  control, lease, acceptDataLoss, timeoutSeconds = 1800, signal, onProgress,
}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Cold file restoration requires explicit data-loss acknowledgement and bounded stages.');
  }
  const stage = (name, action) => runStage(name, action, {
    signal, timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER),
  });
  await stage('cold-restore-authority', stageSignal => assertWindowsColdRestoreLease(control, lease, { signal: stageSignal }));
  const runtimeBundle = await stage('cold-restore-runtime', stageSignal =>
    prepareWindowsColdRestoreRuntimeBundle({ control, lease, signal: stageSignal }));
  const options = {
    project: lease.lock.project, backup: lease.backup, expectedSnapshot: lease.snapshot,
    pwsh: lease.pwsh, acceptDataLoss, checkStopped: context => lease.checkStopped(context),
  };
  await stage('cold-restore-project', async stageSignal => {
    onProgress?.({ stage: 'project-files' });
    await restoreProjectSnapshot({ ...options, signal: stageSignal });
  });
  await stage('cold-restore-external', async stageSignal => {
    onProgress?.({ stage: 'external-files' });
    await restoreExternalSnapshot({
      ...options, runtimeBundle, authorizedPaths: lease.authorizedPaths, signal: stageSignal,
    });
  });
  await stage('cold-restored-files', stageSignal => lease.markFilesRestored({ runtimeBundle, signal: stageSignal }));
  return Object.freeze({ status: 'files-restored', runtimeBundle });
}
