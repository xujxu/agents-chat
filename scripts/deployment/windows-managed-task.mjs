import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-managed-task-controller.ps1', import.meta.url));
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const task = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(value);
function refused(cause) {
  return Object.assign(new Error('Managed Windows task discovery refused; retain the existing deployment.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED', runtimeAuthority: false,
  });
}
function capture(value, project, taskName) {
  const record = captureWorkerFields(value, [
    'status', 'runtimeAuthority', 'project', 'taskName', 'definition', 'securityDescriptor',
    'principalSid', 'enabled', 'configuration', 'configurationSha256', 'runtime', 'lease',
  ], 'managed task observation');
  if (record.status !== 'managed-task-observed' || record.runtimeAuthority !== false
    || record.project !== project || record.taskName !== taskName
    || typeof record.definition !== 'string' || !record.definition || record.definition.length > 262144
    || record.definition.includes('\0')
    || typeof record.securityDescriptor !== 'string' || !record.securityDescriptor
    || record.securityDescriptor.length > 65536 || /[\0\r\n]/.test(record.securityDescriptor)
    || typeof record.principalSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(record.principalSid)
    || typeof record.enabled !== 'boolean' || !canonical(record.configuration)
    || path.basename(record.configuration) !== 'configuration.json'
    || typeof record.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.configurationSha256)
    || !['unguarded', 'released'].includes(record.lease)) throw new Error('Invalid managed task observation.');
  const runtime = captureActivatedRuntime(record.runtime);
  if (runtime.configurationSha256 !== record.configurationSha256) throw new Error('Managed runtime configuration differs.');
  return Object.freeze({ ...record, runtime });
}

export async function inspectWindowsManagedTask({ taskName, project, pwsh, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !task(taskName) || !canonical(project) || !canonical(pwsh)) {
    throw refused(new Error('Canonical Windows project/PowerShell paths and an explicit task name are required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original observer identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native managed task observer',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-TaskName', taskName, '-Project', project,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'project', 'taskName', 'controllerIdentity', 'value'], 'managed task readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.project !== project || ready.taskName !== taskName
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) throw new Error('Original managed task observer differs.');
    const observation = capture(ready.value, project, taskName);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A managed task observation request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Managed task observation is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original managed task observer exited.');
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'managed task reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected managed task observation acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected managed task close acknowledgement.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Managed task observer close failed.');
          closed = true;
          wire.close();
          return;
        }
        if (!isDeepStrictEqual(capture(reply.value, project, taskName), observation)) {
          throw new Error('Original managed task observation changed.');
        }
        return observation;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    return Object.freeze({
      identity, observation,
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
