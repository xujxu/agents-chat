const operationNames = [
  'inspect', 'resolveTarget', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
  'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify',
];

export async function runDeployment(options, operations) {
  if (!options || !['deploy', 'upgrade'].includes(options.operation)) {
    throw new Error('Deployment transaction requires deploy or upgrade operation.');
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
  const inspected = await invoke('inspect');
  if (!inspected || typeof inspected.exists !== 'boolean' || typeof inspected.running !== 'boolean'
    || inspected.owned !== true || (!inspected.exists && inspected.running)) {
    throw new Error('Deployment inspection did not establish managed runtime ownership.');
  }
  context.inspection = inspected;
  if (options.operation === 'upgrade' && !inspected.exists) {
    throw new Error('Upgrade requires an existing deployment.');
  }
  context.target = await invoke('resolveTarget');
  await invoke('capacity');
  let stopAttempted = false;
  let sourceMutationAttempted = false;
  try {
    if (inspected.exists) {
      stopAttempted = true;
      await invoke('stop');
      context.phase = 'stopped';
      context.snapshot = await invoke('snapshot');
      await invoke('verifySnapshot');
      await invoke('rotate');
      context.phase = 'backup-ready';
    }
    // A failed source operation may already have modified files.
    sourceMutationAttempted = true;
    await invoke('selectSource');
    context.phase = 'source-selected';
    if (!options.noInstall) await invoke('dependencies');
    context.phase = 'dependencies';
    await invoke('build');
    context.phase = 'building';
    await invoke('configure');
    context.phase = 'configuring';
    await invoke('start');
    context.phase = 'activating';
    if (options.waitSeconds === 0) {
      return { status: 'activation-unverified', backupCreated: inspected.exists };
    }
    await invoke('verify');
    return { status: 'accepted', backupCreated: inspected.exists };
  } catch (error) {
    try {
      if (sourceMutationAttempted) {
        await invoke('stop');
      } else if (stopAttempted && inspected.running) {
        await invoke('start');
      }
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError],
        'Deployment failed and runtime cleanup/restart also failed; inspect before recovery.');
    }
    throw error;
  }
}
