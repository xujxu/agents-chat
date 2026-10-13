import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertWindowsSavedColdScope } from './windows-cold-retirement-closeout.mjs';
import { claimWindowsColdRestore } from './windows-cold-restore-lease.mjs';
import { restoreWindowsColdFiles } from './windows-cold-restore-files.mjs';
import { recoverWindowsColdStartupPolicy } from './windows-cold-startup-recovery.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { runStage } from './stage-runner.mjs';

export async function runWindowsColdRestoreCommand(options = {}) {
  assertWindowsSavedColdScope(options);
  const { control, project, snapshot, pwsh, signal, onProgress, waitSeconds = 120, timeoutSeconds = 1800 } = options;
  if (![waitSeconds, timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Cold restore requires positive stage/readiness deadlines and a valid progress callback.');
  }
  const progress = stage => onProgress?.({ phase: 'cold-restore', stage });
  const stage = (name, action) => {
    progress(name);
    return runStage(name, action, { signal, timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  };
  let lease;
  let configuration;
  let result;
  let failure;
  try {
    let interruptedStartup = false;
    try {
      await lstat(path.join(control, 'recovery-lock/activation-running.json'));
      interruptedStartup = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (interruptedStartup) {
      await stage('cold-startup-policy-recovery', stageSignal =>
        recoverWindowsColdStartupPolicy({ ...options, signal: stageSignal }));
    }
    lease = await stage('cold-restore-admission', stageSignal => claimWindowsColdRestore({
      control, project, backup: path.join(control, 'backup'), node: process.execPath,
      pwsh, profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
      expectedSnapshot: snapshot, signal: stageSignal,
    }));
    await restoreWindowsColdFiles({
      control, lease, acceptDataLoss: true, timeoutSeconds, signal,
      onProgress: event => progress(event.stage),
    });
    configuration = await stage('cold-restored-configuration', stageSignal =>
      lease.inspectRestoredConfiguration({ signal: stageSignal }));
    await stage('cold-retire-runtime', stageSignal => lease.retireRuntime({ signal: stageSignal }));
    const activation = await stage('cold-activation-intent', stageSignal =>
      lease.prepareActivation({ configuration, signal: stageSignal }));
    await stage('cold-activation-start', stageSignal => activation.start({ signal: stageSignal }));
    await stage('cold-runtime-completion', async stageSignal => {
      await activation.completeRuntime({ port: 3010, waitSeconds, signal: stageSignal });
      await configuration.checkFiles({ signal: stageSignal });
    });
    result = Object.freeze({
      status: 'cold-runtime-completed', operationId: lease.lock.operationId,
      backupId: snapshot.id, recoveryEngine: snapshot.recoveryEngine,
      runtimeRelocated: true, closeoutRequired: false,
    });
  } catch (error) { failure = error; }
  const cleanup = [];
  try { await lease?.close(); } catch (error) { cleanup.push(error); }
  try { await configuration?.close(); } catch (error) { cleanup.push(error); }
  if (cleanup.length) {
    throw journalUncertain(new AggregateError(failure ? [failure, ...cleanup] : cleanup, 'Cold restore command cleanup failed.'));
  }
  if (failure) throw failure;
  return result;
}
