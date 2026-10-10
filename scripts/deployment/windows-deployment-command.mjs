import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { parseWindowsCommandArguments } from './windows-command-options.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { acquireLock, loadState, reconcileInterruptedOperation, releaseLock } from './state.mjs';
import { canonicalWorkerDirectory, externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { runWindowsLiveDeployment } from './windows-deployment.mjs';
import { inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { runWindowsFirstCommand } from './windows-first-command.mjs';

const refused = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

export async function runWindowsDeploymentCommand({
  operation, args, project, control, taskName, node, npmCli, git, pwsh, signal, onProgress,
}) {
  if (!['deploy', 'update'].includes(operation)) throw new Error('Unsupported Windows deployment command.');
  const options = parseWindowsCommandArguments(operation, args);
  if (options.help) return {
    status: 'help',
    message: 'Windows command admission supports existing running managed tasks, explicit first NoTunnel deployment, positive health waits and read-only status.',
  };
  if (options.operation === 'verify' || options.waitSeconds === 0 || options.dryRun) {
    throw refused('DEPLOYMENT_COMMAND_MODE_UNSUPPORTED',
      'Verification, no-wait and preview modes are not supported here; no operation was started.');
  }
  if (process.platform !== 'win32' || ![project, control, node, npmCli, git, pwsh].every(canonical)
    || options.project !== undefined && options.project !== project
    || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)) {
    throw refused('DEPLOYMENT_WINDOWS_COMMAND_CONTEXT_REQUIRED',
      'Windows command admission requires matching canonical project/control/tools and an explicit managed task.');
  }
  signal?.throwIfAborted();
  await canonicalWorkerDirectory(project);
  try { await lstat(control); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (options.operation === 'status') return { status: 'unmanaged', project, control, phase: null };
    throw refused('DEPLOYMENT_CONTROL_REQUIRED', 'The private supervisor must prepare the external control directory.');
  }
  await externalWorkerDirectory(control, project);
  const names = await readdir(control);
  const originalState = await loadState(control);
  if (originalState && originalState.project !== project) {
    throw refused('DEPLOYMENT_CONTROL_FOREIGN', 'Deployment control state belongs to another project.');
  }
  await readDeploymentReceipt(control, project);
  const status = await reconcileInterruptedOperation(control);
  if (options.operation === 'status') return { ...status, project, control, targetCommit: originalState?.targetCommit ?? null };
  if (!originalState && names.length) {
    throw refused('DEPLOYMENT_CONTROL_UNBOUND', 'Nonempty control directory has no project-bound state; retain and inspect it.');
  }
  if (!['idle', 'already-current', 'preflight-refused', 'prior-runtime-restored'].includes(status.status)) {
    throw refused('DEPLOYMENT_RECOVERY_REQUIRED', 'Existing operation needs inspection or recovery before another deployment.');
  }
  if (options.firstInstall) {
    if (originalState || names.length) {
      throw refused('DEPLOYMENT_FRESH_INSTALL_REQUIRED', 'Explicit first-task policy requires a fresh installation with no deployment evidence.');
    }
    return runWindowsFirstCommand({
      options, project, control, taskName, node, npmCli, git, pwsh, signal, onProgress,
    });
  }
  let scope;
  let lock;
  let result;
  const errors = [];
  try {
    scope = await inspectWindowsManagedTask({ project, taskName, pwsh, signal });
    const bytes = await readWorkerFile(scope.observation.configuration, 4 * 1024 * 1024, { privateMode: true });
    if (createHash('sha256').update(bytes).digest('hex') !== scope.observation.configurationSha256) {
      throw refused('DEPLOYMENT_CONFIGURATION_CHANGED', 'Installed runtime configuration changed during command admission.');
    }
    const configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    await scope.check({ signal });
    lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    if (!same(await loadState(control), originalState)) {
      throw refused('DEPLOYMENT_STATE_CHANGED', 'Deployment state changed during command admission.');
    }
    result = await runWindowsLiveDeployment({
      ...options, scope, control, lock, node, npmCli, git, pwsh,
      environment: configuration.command.environment, port: 3010, deploymentBytes: 2 * 1024 ** 3,
      signal, onProgress,
    });
    result = Object.freeze({ ...result, operationId: lock.operationId });
    lock = undefined;
  } catch (error) {
    errors.push(error);
    if (lock && !hasUnsettledWorker(error)) {
      try {
        if (same(await loadState(control), originalState)) {
          await scope.check({ signal: null });
          await releaseLock(control, lock, { pwsh });
        }
      } catch (cleanup) { errors.push(journalUncertain(cleanup)); }
    }
  }
  try { await scope?.close(); }
  catch (error) { errors.push(journalUncertain(error)); }
  if (errors.length) {
    if (errors.length === 1) throw errors[0];
    throw journalUncertain(new AggregateError(errors, 'Windows command and original observation cleanup failed.'));
  }
  return result;
}
