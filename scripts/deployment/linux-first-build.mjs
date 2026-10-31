import path from 'node:path';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { prepareLinuxOwnedSourceBuild } from './linux-source-build.mjs';

export async function prepareLinuxFirstBuild({ installation, control, lock, operation, git, environment = {}, signal }) {
  const owner = captureLockOwner(lock);
  const { project, account, executables, runtime } = installation.identity;
  if (runtime !== 'absent' || owner.project !== project
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('Fresh build requires the inspected project and its own deployment control.');
  }
  const authority = async (phase, commit, stageSignal) => {
    signal?.throwIfAborted();
    stageSignal?.throwIfAborted();
    await assertLockOwner(control, owner);
    const state = await loadState(control);
    if (!phase || state?.operationId !== owner.operationId || state.project !== project
      || state.operation !== 'deploy' || state.priorRuntime !== 'absent' || state.backupId !== null
      || state.phase !== phase || state.errorCode !== null
      || commit !== undefined && state.targetCommit !== commit) {
      throw new Error(`Fresh build requires its own ${phase ?? 'supported'} phase and exact target.`);
    }
    await installation.checkUninstalled();
    await assertLockOwner(control, owner);
  };
  await authority('preflight', undefined, signal);
  await installation.checkFreshRuntime();
  const node = executables[1].file;
  const buildEnvironment = installation.configuration.buildEnvironment({
    PATH: `${path.dirname(node)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: account.home, USER: account.user, LOGNAME: account.user,
    NEXT_TELEMETRY_DISABLED: '1', ...environment,
  });
  const phases = { select: 'source-selected', dependencies: 'dependencies', build: 'building' };
  const stages = await prepareLinuxOwnedSourceBuild({
    project, uid: account.uid, gid: account.gid, node, npmCli: executables[0].target,
    operation, git, environment: buildEnvironment, signal,
    checkRead: async ({ signal: stageSignal }) => {
      await authority('preflight', undefined, stageSignal);
      await installation.checkFreshRuntime();
    },
    checkMutation: ({ stage, commit, signal: stageSignal }) =>
      authority(Object.hasOwn(phases, stage) ? phases[stage] : undefined, commit, stageSignal),
  });
  return Object.freeze({
    inspect: stages.inspect, resolve: stages.resolve, select: stages.select,
    npm: async options => stages.npm({
      ...options,
      environment: installation.configuration.buildEnvironment(options.environment ?? buildEnvironment),
    }),
  });
}
