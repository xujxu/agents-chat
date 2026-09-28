import { alreadyCurrent, previewUpdate } from './update-policy.mjs';
import { runStage } from './stage-runner.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

const operationNames = [
  'record', 'inspect', 'resolveTarget', 'admit', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
  'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
];

export async function runDeployment(options, operations) {
  if (!options || !['deploy', 'update'].includes(options.operation)) {
    throw new Error('Deployment transaction requires deploy or update operation.');
  }
  if (options.dryRun) return previewUpdate(options, operations?.previewReaders);
  if (!operations || operationNames.some(name => typeof operations[name] !== 'function')) {
    throw new Error('Deployment transaction requires every native operation.');
  }
  if (options.waitSeconds !== undefined
    && (!Number.isSafeInteger(options.waitSeconds) || options.waitSeconds < 0)) {
    throw new Error('Invalid deployment wait interval.');
  }
  const timeoutSeconds = options.timeoutSeconds ?? 1800;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Invalid deployment timeout interval.');
  }
  const context = { options, inspection: null, target: null, admission: null, snapshot: null, phase: 'preflight' };
  const invoke = async (name, recovering = false) => {
    const seconds = name === 'verify'
      ? Math.min(timeoutSeconds, recovering ? options.waitSeconds || 120 : options.waitSeconds ?? 120) : timeoutSeconds;
    return runStage(name, signal => operations[name]({
      ...context, signal, recovering, activationPurpose: recovering && !sourceMutationAttempted ? 'prior-runtime' : 'deployment',
    }), {
      timeoutMs: Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER),
      signal: recovering ? undefined : options.signal,
    });
  };
  const record = async phase => {
    await operations.record(phase, context);
    context.phase = phase;
  };
  let inspected;
  let preflightComplete = false;
  let stopAttempted = false;
  let sourceMutationAttempted = false;
  try {
    inspected = await invoke('inspect');
    if (!inspected || typeof inspected.exists !== 'boolean' || typeof inspected.running !== 'boolean'
      || inspected.owned !== true || (!inspected.exists && inspected.running)) {
      throw new Error('Deployment inspection did not establish managed runtime ownership.');
    }
    context.inspection = inspected;
    if (options.operation === 'update' && !inspected.exists) {
      throw new Error('Update requires an existing deployment.');
    }
    context.target = await invoke('resolveTarget');
    const admission = await invoke('admit');
    if (admission?.compatibility !== 'passed') {
      throw new Error('Deployment compatibility admission must pass before downtime.');
    }
    if (admission.check !== undefined && typeof admission.check !== 'function') {
      throw new Error('Retained deployment compatibility check must be callable.');
    }
    context.admission = admission;
    const current = alreadyCurrent({
      ...admission.current, operation: options.operation, target: context.target?.commit,
    });
    if (current.skip && inspected.running) {
      return { status: 'already-current', backupCreated: false };
    }
    await invoke('capacity');
    if (admission.check) {
      await runStage('compatibility-recheck', signal => admission.check({ signal }), {
        timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal: options.signal,
      });
    }
    await record('preflight');
    preflightComplete = true;
    if (inspected.exists) {
      await record('stopped');
      stopAttempted = true;
      await invoke('stop');
      await record('copying');
      context.snapshot = await invoke('snapshot');
      await invoke('verifySnapshot');
      await record('rotating');
      await invoke('rotate');
      await record('backup-ready');
    }
    // A failed source operation may already have modified files.
    await record('source-selected');
    sourceMutationAttempted = true;
    await invoke('selectSource');
    await record('dependencies');
    if (!options.noInstall) await invoke('dependencies');
    await record('building');
    await invoke('build');
    await record('configuring');
    await invoke('configure');
    await record('activating');
    await invoke('start');
    if (options.waitSeconds === 0) {
      await record('activation-unverified');
      return { status: 'activation-unverified', backupCreated: inspected.exists };
    }
    await invoke('verify');
    await record('accepted');
    return { status: 'accepted', backupCreated: inspected.exists };
  } catch (error) {
    if (!preflightComplete && !hasUnsettledWorker(error)) throw error;
    const errors = [error];
    let priorRuntimeRestored = false;
    try {
      if (!hasUnsettledWorker(error)) {
        if (sourceMutationAttempted) {
          await invoke('stop', true);
        } else if (stopAttempted && inspected.running) {
          await invoke('start', true);
          await invoke('verify', true);
          priorRuntimeRestored = true;
        }
      }
    } catch (recoveryError) {
      errors.push(recoveryError);
    }
    const blocked = errors.some(hasUnsettledWorker);
    context.errorCode = blocked ? 'DEPLOYMENT_WORKER_UNSETTLED' : error?.code ?? 'DEPLOYMENT_FAILED';
    try { await record(blocked ? 'blocked' : priorRuntimeRestored ? 'prior-runtime-restored' : 'recovery-required'); }
    catch (stateError) { errors.push(stateError); }
    if (errors.length > 1) {
      throw Object.assign(new AggregateError(errors,
        'Deployment failed and runtime cleanup/restart or recovery-state recording also failed; inspect before recovery.'), {
        recoveryAllowed: !errors.some(hasUnsettledWorker),
      });
    }
    throw error;
  }
}
