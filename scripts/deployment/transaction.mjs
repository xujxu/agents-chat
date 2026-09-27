const operationNames = [
  'record', 'inspect', 'resolveTarget', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
  'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
];

export async function runDeployment(options, operations) {
  if (!options || !['deploy', 'update'].includes(options.operation)) {
    throw new Error('Deployment transaction requires deploy or update operation.');
  }
  if (!operations || operationNames.some(name => typeof operations[name] !== 'function')) {
    throw new Error('Deployment transaction requires every native operation.');
  }
  if (options.waitSeconds !== undefined
    && (!Number.isSafeInteger(options.waitSeconds) || options.waitSeconds < 0)) {
    throw new Error('Invalid deployment wait interval.');
  }
  const context = { options, inspection: null, target: null, snapshot: null, phase: 'preflight' };
  const invoke = async name => operations[name](context);
  const record = async phase => {
    await operations.record(phase, context);
    context.phase = phase;
  };
  const inspected = await invoke('inspect');
  if (!inspected || typeof inspected.exists !== 'boolean' || typeof inspected.running !== 'boolean'
    || inspected.owned !== true || (!inspected.exists && inspected.running)) {
    throw new Error('Deployment inspection did not establish managed runtime ownership.');
  }
  context.inspection = inspected;
  if (options.operation === 'update' && !inspected.exists) {
    throw new Error('Update requires an existing deployment.');
  }
  context.target = await invoke('resolveTarget');
  await invoke('capacity');
  await record('preflight');
  let stopAttempted = false;
  let sourceMutationAttempted = false;
  try {
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
    const errors = [error];
    try {
      if (sourceMutationAttempted) {
        await invoke('stop');
      } else if (stopAttempted && inspected.running) {
        await invoke('start');
      }
    } catch (recoveryError) {
      errors.push(recoveryError);
    }
    try { await record('recovery-required'); }
    catch (stateError) { errors.push(stateError); }
    if (errors.length > 1) {
      throw new AggregateError(errors,
        'Deployment failed and runtime cleanup/restart or recovery-state recording also failed; inspect before recovery.');
    }
    throw error;
  }
}
