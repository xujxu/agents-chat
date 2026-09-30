import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { parseArguments } from './cli.mjs';
import { inspectInstalledLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { runLinuxLiveDeployment } from './linux-deployment.mjs';
import { acquireLock, loadState, reconcileInterruptedOperation, releaseLock } from './state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

async function inspectControl(control, project) {
  try { await lstat(control); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await canonicalWorkerDirectory(control, { privateMode: true });
  const names = await readdir(control);
  if (names.includes('state.json')) {
    await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
  }
  const state = await loadState(control);
  if (state && state.project !== project) {
    throw refusal('DEPLOYMENT_CONTROL_FOREIGN', 'Deployment control state belongs to another project.');
  }
  await readDeploymentReceipt(control, project);
  return { state, names };
}

export async function runLinuxUpdateCommand({ args, unit = 'agents-chat.service', project: defaultProject, signal, onProgress }) {
  const options = parseArguments('update', args);
  if (options.help) return { status: 'help', message: 'Linux update supports an existing running service, positive health waits and read-only status.' };
  if (options.dryRun || options.operation === 'verify' || options.waitSeconds === 0) {
    throw refusal('DEPLOYMENT_COMMAND_MODE_UNSUPPORTED',
      'Native dry-run, deferred verification and no-wait activation are not yet supported; no operation was started.');
  }
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw refusal('DEPLOYMENT_PRIVILEGE_REQUIRED', 'Linux update requires the root system-manager controller.');
  }
  const suppliedProject = options.project ?? defaultProject;
  if (typeof suppliedProject !== 'string' || !path.isAbsolute(suppliedProject)) {
    throw refusal('DEPLOYMENT_PROJECT_REQUIRED', 'Supply an absolute deployment project directory.');
  }
  signal?.throwIfAborted();
  const { root: project } = await canonicalWorkerDirectory(suppliedProject);
  const control = path.join(path.dirname(project), `.${path.basename(project)}.deployment`);
  const existing = await inspectControl(control, project);
  if (options.operation === 'status') {
    if (!existing) return { status: 'unmanaged', project, control, phase: null };
    return { ...await reconcileInterruptedOperation(control), project, control,
      targetCommit: existing.state?.targetCommit ?? null };
  }
  if (existing) {
    if (!existing.state && existing.names.length) {
      throw refusal('DEPLOYMENT_CONTROL_UNBOUND', 'Nonempty control directory has no project-bound state; retain and inspect it.');
    }
    const status = await reconcileInterruptedOperation(control);
    if (!['idle', 'already-current', 'preflight-refused', 'prior-runtime-restored'].includes(status.status)) {
      throw refusal('DEPLOYMENT_RECOVERY_REQUIRED', 'Existing operation needs inspection or recovery before another update.');
    }
  }
  try { await access('/usr/bin/git', constants.X_OK); }
  catch (cause) {
    throw Object.assign(new Error('Install Git for the installed service account before updating; /usr/bin/git is required.', { cause }),
      { code: 'DEPLOYMENT_GIT_REQUIRED' });
  }
  let service;
  let lock;
  let originalState;
  let result;
  const errors = [];
  try {
    service = await inspectInstalledLinuxService({ unit, project });
    const configuration = await inspectLinuxConfiguration({ service, profile: 'agents-chat-auth-638c553', signal });
    const installed = configuration.buildEnvironment({});
    const runtime = service.identity.runtime;
    const environment = {
      ...installed,
      PATH: installed.PATH ?? `${path.dirname(service.identity.executables[1].file)}:/usr/bin:/bin`,
      HOME: installed.HOME ?? runtime.home,
      USER: installed.USER ?? runtime.user,
      LOGNAME: installed.LOGNAME ?? runtime.user,
      NEXT_TELEMETRY_DISABLED: installed.NEXT_TELEMETRY_DISABLED ?? '1',
    };
    if (!existing) {
      await mkdir(control, { mode: 0o700 });
      await syncWorkerDirectory(path.dirname(control));
    }
    await configuration.check({ signal });
    originalState = (await inspectControl(control, project)).state;
    lock = await acquireLock(control, { project, operationId: randomUUID() });
    if (!same(await loadState(control), originalState)) {
      throw refusal('DEPLOYMENT_STATE_CHANGED', 'Deployment state changed during command admission.');
    }
    result = await runLinuxLiveDeployment({
      ...options, service, control, lock, git: '/usr/bin/git', environment, port: 3010,
      deploymentBytes: 2 * 1024 ** 3, signal, onProgress,
    });
    lock = undefined;
  } catch (error) {
    errors.push(error);
    if (lock && !hasUnsettledWorker(error)) {
      try {
        if (same(await loadState(control), originalState)) {
          await service.check();
          await releaseLock(control, lock);
        }
      } catch (cleanup) { errors.push(cleanup); }
    }
  }
  try { await service?.close(); }
  catch (error) { errors.push(error); }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Linux update command and cleanup failed.');
  return result;
}
