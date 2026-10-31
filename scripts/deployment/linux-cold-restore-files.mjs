import { claimLinuxColdRestore } from './linux-cold-restore-lease.mjs';
import { restoreProjectSnapshot } from './restore-project.mjs';
import { restoreExternalSnapshot } from './restore-external.mjs';
import { runStage } from './stage-runner.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function restoreLinuxColdFiles({
  control, project, backup, acceptDataLoss, timeoutSeconds = 1800, signal, expectedNative,
}) {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Cold restore requires a positive stage deadline.');
  }
  const stage = (name, work) => runStage(name, work, {
    signal, timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER),
  });
  const claimed = await stage('cold-restore-admission', stageSignal =>
    claimLinuxColdRestore({ control, project, backup, acceptDataLoss, signal: stageSignal, expectedNative }));
  const options = {
    project, backup, acceptDataLoss, expectedSnapshot: claimed.snapshot,
    checkStopped: context => claimed.checkStopped(context),
  };
  try {
    await stage('cold-restore-project', stageSignal => restoreProjectSnapshot({ ...options, signal: stageSignal }));
    await stage('cold-restore-external', stageSignal => restoreExternalSnapshot({
      ...options, signal: stageSignal, authorizedPaths: claimed.authorizedPaths,
    }));
    await stage('cold-restored-files', stageSignal => claimed.markFilesRestored({ signal: stageSignal }));
    const continuedSignal = signal ?? new AbortController().signal;
    return Object.freeze({
      owner: claimed.owner, lock: claimed.lock, state: claimed.state, snapshot: claimed.snapshot,
      service: claimed.service, providers: claimed.providers, authorizedPaths: claimed.authorizedPaths,
      status: 'files-restored', close: claimed.close,
      check: (context = {}) => claimed.check({ signal: context.signal ?? continuedSignal }),
      checkStopped: (context = {}) => claimed.checkStopped({ signal: context.signal ?? continuedSignal }),
      prepareActivation: (context = {}) => claimed.prepareActivation({ signal: context.signal ?? continuedSignal }),
    });
  } catch (error) {
    try { await claimed.close(); }
    catch (cleanup) {
      throw journalUncertain(new AggregateError([error, cleanup], 'Cold file restoration and lease cleanup failed.'));
    }
    throw error;
  }
}
