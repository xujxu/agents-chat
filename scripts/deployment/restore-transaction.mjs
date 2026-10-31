import { runStage } from './stage-runner.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

const operationNames = [
  'record', 'inspect', 'inspectBackup', 'capacity', 'stop', 'restoreFiles', 'configure', 'start', 'verify',
];

export async function runRestore(options, operations) {
  if (!options || options.operation !== 'restore' || options.dryRun) {
    throw new Error('Restoration requires an explicit restore operation.');
  }
  if (options.acceptDataLoss !== true) {
    throw new Error('Restore requires explicit acknowledgement of post-backup data loss.');
  }
  const timeoutSeconds = options.timeoutSeconds ?? 1800;
  const waitSeconds = options.waitSeconds ?? 120;
  if (![timeoutSeconds, waitSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Restore timeout and health wait must be positive safe integers.');
  }
  if (!operations || operationNames.some(name => typeof operations[name] !== 'function')) {
    throw new Error('Restoration requires every native operation.');
  }
  const context = { options, inspection: null, snapshot: null, phase: 'restore-preflight' };
  const stageOptions = (name, recovering) => ({
    timeoutMs: Math.min((name === 'verify' ? Math.min(timeoutSeconds, waitSeconds) : timeoutSeconds) * 1000,
      Number.MAX_SAFE_INTEGER),
    signal: recovering ? undefined : options.signal,
  });
  const invoke = (name, recovering = false) => runStage(name, signal => operations[name]({
    ...context, signal, recovering, activationPurpose: 'restore',
  }), stageOptions(name, recovering));
  const record = async phase => {
    await operations.record(phase, context);
    context.phase = phase;
  };
  let stopAttempted = false;
  let recorded = false;
  try {
    const inspection = await invoke('inspect');
    if (!inspection || typeof inspection.exists !== 'boolean' || typeof inspection.running !== 'boolean'
      || inspection.owned !== true || !inspection.exists && inspection.running) {
      throw new Error('Restoration inspection did not establish managed runtime ownership.');
    }
    context.inspection = inspection;
    const backup = await invoke('inspectBackup');
    if (!backup || typeof backup.check !== 'function'
      || !/^[a-zA-Z0-9_-]+$/.test(backup.snapshot?.id ?? '')
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(backup.snapshot?.source?.commit ?? '')) {
      throw new Error('Restoration requires a validated backup and retained source check.');
    }
    context.snapshot = backup.snapshot;
    await invoke('capacity');
    await runStage('restore-recheck', signal => backup.check({ signal }), stageOptions('restore-recheck', false));
    await record('restore-preflight');
    recorded = true;
    await record('restoring');
    stopAttempted = true;
    await invoke('stop');
    await invoke('restoreFiles');
    await invoke('configure');
    await record('restore-activating');
    await invoke('start');
    await invoke('verify');
    await record('restored');
    return { status: 'restored', backupId: context.snapshot.id };
  } catch (error) {
    if (!recorded && !hasUnsettledWorker(error)) throw error;
    const errors = [error];
    if (stopAttempted && !hasUnsettledWorker(error)) {
      try { await invoke('stop', true); }
      catch (cleanupError) { errors.push(cleanupError); }
    }
    const blocked = errors.some(hasUnsettledWorker);
    context.errorCode = blocked ? 'DEPLOYMENT_WORKER_UNSETTLED' : error?.code ?? 'DEPLOYMENT_RESTORE_FAILED';
    try { await record(blocked ? 'blocked' : 'recovery-required'); }
    catch (stateError) { errors.push(stateError); }
    if (errors.length > 1) {
      throw Object.assign(new AggregateError(errors,
        'Restoration and cleanup or recovery-state recording failed; retain the backup and inspect before retrying.'), {
        recoveryAllowed: !errors.some(hasUnsettledWorker),
      });
    }
    throw error;
  }
}
