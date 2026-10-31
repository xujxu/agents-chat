import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { externalWorkerDirectory } from './worker-files.mjs';
import { assertWindowsFirstInstallScope } from './windows-first-install.mjs';
import { assertWindowsFirstConfiguration } from './windows-configuration.mjs';
import { prepareOwnedSourceBuild } from './owned-source-build.mjs';

export async function prepareWindowsFirstBuild({
  scope, configuration, control, lock: supplied, operation, node, npmCli, git, pwsh, environment = {}, signal,
}) {
  const observed = await assertWindowsFirstInstallScope(scope, { controlEvidence: false, signal });
  const project = observed.project;
  const lock = captureLockOwner(supplied);
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) !== 24
    || lock.project !== project || pwsh !== scope.identity.pwsh
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('Fresh Windows build requires its original project, controller and deployment control.');
  }
  const observeTools = async () => Promise.all([node, npmCli, git, pwsh].map(async file => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
      throw new Error('Fresh Windows build requires explicit external tools.');
    }
    const target = await realpath(file);
    const relative = path.relative(project, target);
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() || relative === '' || !path.isAbsolute(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)) {
      throw new Error('Fresh Windows build tools must remain outside the mutable project.');
    }
    return { target, dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs };
  }));
  const tools = await observeTools();
  if (tools[0].target !== await realpath(process.execPath)
    || tools[1].target !== path.join(path.dirname(tools[0].target), 'node_modules', 'npm', 'bin', 'npm-cli.js')) {
    throw new Error('Fresh Windows build requires the original controller Node and its bundled npm CLI.');
  }
  const authority = async (phase, commit, stageSignal, fresh = false) => {
    signal?.throwIfAborted();
    stageSignal?.throwIfAborted();
    await externalWorkerDirectory(control, project);
    await assertLockOwner(control, lock);
    const state = await loadState(control);
    if (!phase || state?.operationId !== lock.operationId || state.project !== project
      || state.operation !== 'deploy' || state.priorRuntime !== 'absent' || state.backupId !== null
      || state.runtimeIdentity !== 'first-install-absent' || state.phase !== phase || state.errorCode !== null
      || commit !== undefined && state.targetCommit !== commit) {
      throw new Error(`Fresh Windows build requires its own ${phase ?? 'supported'} phase and exact target.`);
    }
    await assertWindowsFirstInstallScope(scope, { fresh, controlEvidence: false, signal: stageSignal });
    await assertWindowsFirstConfiguration(configuration, { scope, signal: stageSignal });
    if (!same(await observeTools(), tools)) throw new Error('Original first-install toolchain changed.');
    await assertLockOwner(control, lock);
  };
  await authority('preflight', undefined, signal, true);
  const buildEnvironment = configuration.buildEnvironment(environment);
  const phases = { select: 'source-selected', dependencies: 'dependencies', build: 'building' };
  const stages = await prepareOwnedSourceBuild({
    project, node, npmCli, operation, git, environment: buildEnvironment, signal,
    runtime: { pwsh, accountSid: observed.accountSid, sessionId: observed.sessionId },
    checkRead: ({ signal: stageSignal }) => authority('preflight', undefined, stageSignal, true),
    checkMutation: ({ stage, commit, signal: stageSignal }) =>
      authority(Object.hasOwn(phases, stage) ? phases[stage] : undefined, commit, stageSignal),
  });
  return Object.freeze({
    inspect: stages.inspect, resolve: stages.resolve, select: stages.select,
    npm: async options => stages.npm({
      ...options, environment: configuration.buildEnvironment(options.environment ?? buildEnvironment),
    }),
  });
}
