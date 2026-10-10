import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, loadState, releaseLock } from './state.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { inspectWindowsFirstInstall } from './windows-first-install.mjs';
import { inspectWindowsFirstConfiguration } from './windows-configuration.mjs';
import { runWindowsFirstDeployment } from './windows-first-deployment.mjs';

function firstEnvironment({ node, git, pwsh }) {
  const home = os.homedir();
  const { SystemRoot, TEMP, TMP } = process.env;
  if (![home, SystemRoot, TEMP, TMP].every(value => typeof value === 'string'
    && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw Object.assign(new Error('First deployment requires the sanitized supervisor environment and a native current-user home.'), {
      code: 'DEPLOYMENT_WINDOWS_FIRST_ENVIRONMENT_REQUIRED',
    });
  }
  return {
    SystemRoot, WINDIR: SystemRoot, TEMP, TMP, HOME: home,
    COMSPEC: path.join(SystemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [path.dirname(node), path.dirname(git), path.dirname(pwsh),
      path.join(SystemRoot, 'System32'), SystemRoot, path.join(SystemRoot, 'System32', 'Wbem')].join(path.delimiter),
    npm_config_cache: path.join(home, 'AppData', 'Local', 'npm-cache'),
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export async function runWindowsFirstCommand({
  options, project, control, taskName, node, npmCli, git, pwsh, signal, onProgress,
}) {
  const environment = firstEnvironment({ node, git, pwsh });
  let scope;
  let configuration;
  let lock;
  let result;
  const errors = [];
  try {
    scope = await inspectWindowsFirstInstall({ project, taskName, pwsh, signal });
    configuration = await inspectWindowsFirstConfiguration({
      scope, pwsh, profile: 'agents-chat-auth-638c553', signal,
    });
    lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    if (await loadState(control) !== null) {
      throw journalUncertain(new Error('Fresh deployment state changed during first-command admission.'));
    }
    result = Object.freeze({
      ...await runWindowsFirstDeployment({
        ...options, scope, configuration, control, lock, node, npmCli, git, pwsh, environment,
        port: 3010, deploymentBytes: 2 * 1024 ** 3, signal, onProgress,
      }),
      operationId: lock.operationId,
    });
  } catch (error) {
    errors.push(error);
    if (lock && !hasUnsettledWorker(error)) {
      try {
        if (await loadState(control) === null) {
          await scope.checkFreshRuntime({ signal: null });
          await releaseLock(control, lock, { pwsh });
        }
      } catch (cleanup) { errors.push(journalUncertain(cleanup)); }
    }
  }
  for (const resource of [configuration, scope]) {
    try { await resource?.close(); }
    catch (error) { errors.push(journalUncertain(error)); }
  }
  if (errors.length) {
    if (errors.length === 1) throw errors[0];
    throw journalUncertain(new AggregateError(errors, 'First command and original observation cleanup failed.'));
  }
  return result;
}
