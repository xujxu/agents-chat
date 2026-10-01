import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same, promisify } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./windows-task-inspect.ps1', import.meta.url));
const text = (value, maximum = 4096) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && !/[\0\r\n]/.test(value);

function refusal(changed = false, check = 'definition') {
  return Object.assign(new Error(changed
    ? 'Retained Windows task definition changed or cannot be re-established.'
    : 'Windows task definition inspection refused; inspect the named task, privilege and supported policy.'), {
    code: changed ? 'DEPLOYMENT_WINDOWS_TASK_CHANGED' : 'DEPLOYMENT_WINDOWS_TASK_UNSUPPORTED',
    runtimeAuthority: false, check,
  });
}

function capture(value, expected) {
  const record = captureWorkerFields(value, [
    'version', 'taskName', 'taskPath', 'project', 'watchdog', 'principalSid', 'options',
    'definition', 'securityDescriptor', 'enabled', 'state', 'lastRunTicks', 'lastResult', 'instances',
  ], 'Windows task definition');
  const options = captureWorkerFields(record.options, [
    'UserId', 'TaskLogonType', 'TaskTriggerType', 'NoTunnel',
  ], 'Windows task options');
  if (record.version !== 1 || record.taskName !== expected.taskName || record.taskPath !== '\\'
    || record.project !== expected.project || record.watchdog !== expected.watchdog
    || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(record.principalSid ?? '')
    || !text(options.UserId) || !['Interactive', 'S4U'].includes(options.TaskLogonType)
    || !['AtLogOn', 'AtStartup'].includes(options.TaskTriggerType) || typeof options.NoTunnel !== 'boolean'
    || typeof record.definition !== 'string' || !record.definition || record.definition.length > 262144
    || record.definition.includes('\0') || !text(record.securityDescriptor, 65536)
    || typeof record.enabled !== 'boolean' || !['Disabled', 'Queued', 'Ready', 'Running'].includes(record.state)
    || typeof record.lastRunTicks !== 'string' || !/^[0-9]{1,19}$/.test(record.lastRunTicks)
    || !Number.isSafeInteger(record.lastResult) || !Array.isArray(record.instances) || record.instances.length > 128) {
    throw refusal();
  }
  const instances = record.instances.map(value => {
    const instance = captureWorkerFields(value, ['instanceGuid', 'enginePid', 'state', 'currentAction'], 'Windows task instance');
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance.instanceGuid ?? '')
      || !Number.isSafeInteger(instance.enginePid) || instance.enginePid <= 0 || instance.enginePid > 2147483647
      || !Number.isInteger(instance.state) || instance.state < 1 || instance.state > 4
      || typeof instance.currentAction !== 'string' || instance.currentAction.length > 4096
      || /[\0\r\n]/.test(instance.currentAction)) throw refusal();
    return instance;
  });
  if (new Set(instances.map(instance => instance.instanceGuid)).size !== instances.length) throw refusal();
  return Object.freeze({ ...record, options, instances: Object.freeze(instances) });
}

export async function inspectWindowsTaskDefinition({ taskName, project, watchdog, signal }) {
  try {
    signal?.throwIfAborted();
    if (process.platform !== 'win32' || typeof taskName !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)
      || !text(project) || !text(watchdog) || !path.isAbsolute(project) || !path.isAbsolute(watchdog)
      || watchdog !== path.join(project, 'scripts', 'service-watchdog.ps1')
      || !text(process.env.SystemRoot) || !path.isAbsolute(process.env.SystemRoot)) throw refusal();
    const expected = Object.freeze({ taskName, project, watchdog });
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const observe = async checkSignal => {
      checkSignal?.throwIfAborted();
      if (await realpath(project) !== project || await realpath(watchdog) !== watchdog) throw refusal();
      let stdout;
      try {
        ({ stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', script, '-TaskName', taskName, '-ProjectDir', project, '-WatchdogScript', watchdog], {
          windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, signal: checkSignal,
        }));
      } catch (error) {
        checkSignal?.throwIfAborted();
        const check = typeof error?.stderr === 'string'
          ? error.stderr.match(/Task definition inspection refused: (input|observer-privilege|definition|stable-definition)\./)?.[1]
          : undefined;
        throw refusal(false, check ?? 'native-inspection');
      }
      checkSignal?.throwIfAborted();
      if (await realpath(project) !== project || await realpath(watchdog) !== watchdog) throw refusal();
      return capture(JSON.parse(stdout), expected);
    };
    const identity = await observe(signal);
    return Object.freeze({
      status: 'definition-observed', runtimeAuthority: false, identity,
      async check({ signal: checkSignal } = {}) {
        try {
          if (!same(await observe(checkSignal), identity)) throw refusal(true);
        } catch (error) {
          checkSignal?.throwIfAborted();
          throw refusal(true, error?.check);
        }
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw refusal(false, error?.check);
  }
}
