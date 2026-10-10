import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState, requireNoServiceMaintenance } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { assertWindowsFirstInstallScope } from './windows-first-install.mjs';
import { assertWindowsFirstConfiguration } from './windows-configuration.mjs';
import { readWorkerOperation } from './worker-operation.mjs';
import { readWorkerJournal } from './worker-journal.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-first-runtime.ps1', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const operational = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'NEXT_TELEMETRY_DISABLED']);
function refused(cause) {
  return Object.assign(new Error('First Windows runtime preparation refused; retain its bundle and any inhibited task evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_RUNTIME_REFUSED', runtimeAuthority: false,
  });
}

export async function prepareWindowsFirstRuntime({
  scope, configuration, control, lock: supplied, built, node, pwsh, environment = {}, port, signal,
}) {
  let bridge;
  let closed = false;
  try {
    signal?.throwIfAborted();
    const observed = await assertWindowsFirstInstallScope(scope, { fresh: false, signal });
    const lock = captureLockOwner(supplied);
    const project = observed.project;
    if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) !== 24
      || lock.project !== project || pwsh !== scope.identity.pwsh
      || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lock.operationId)
      || !Number.isSafeInteger(port) || port < 1 || port > 65535
      || typeof node !== 'string' || !path.isAbsolute(node) || await realpath(node) !== await realpath(process.execPath)) {
      throw new Error('Original first-runtime project, controller tools and port are required.');
    }
    await externalWorkerDirectory(path.dirname(script), project);
    await externalWorkerDirectory(control, project);
    await assertWindowsFirstConfiguration(configuration, { scope, signal });
    const effective = configuration.buildEnvironment(environment);
    const startup = Object.freeze({
      ...Object.fromEntries(Object.entries(effective).filter(([key]) => operational.has(key))),
      ...configuration.startupEnvironment(),
    });
    const state = await loadState(control);
    if (state?.project !== project || state.operationId !== lock.operationId || state.operation !== 'deploy'
      || state.priorRuntime !== 'absent' || state.runtimeIdentity !== 'first-install-absent' || state.backupId !== null
      || state.phase !== 'configuring' || state.previousPhase !== 'building' || state.startedAt !== lock.createdAt
      || state.errorCode !== null || built?.sourceCommit !== state.targetCommit
      || typeof built.source?.check !== 'function' || typeof built.artifacts?.check !== 'function') {
      throw new Error('First runtime requires its original configuring phase and exact build.');
    }
    const workers = await readWorkerOperation(control);
    if (workers.at(-1)?.phase !== 'sealed' || !same(workers[0].lock, lock)) {
      throw new Error('First runtime requires the original sealed worker operation.');
    }
    for (const record of workers.filter(record => record.phase === 'enrolled')) {
      const receipts = await readWorkerJournal(control, {
        project, operationId: lock.operationId, workerId: record.workerId, controllerIdentity: lock.processIdentity,
      });
      if (receipts.at(-1)?.phase !== 'settled') throw new Error('First-runtime workers are not settled.');
    }
    const authority = async requestSignal => {
      requestSignal?.throwIfAborted();
      await assertLockOwner(control, lock);
      await requireNoServiceMaintenance(control);
      if (!same(await loadState(control), state) || !same(await readWorkerOperation(control), workers)) {
        throw new Error('Original first-runtime authority changed.');
      }
      await assertWindowsFirstConfiguration(configuration, { scope, signal: requestSignal });
      await built.source.check({ signal: requestSignal });
      await built.artifacts.check({ signal: requestSignal });
    };
    await authority(signal);
    const next = path.join(project, 'node_modules/next/dist/bin/next');
    await readWorkerFile(next, 1024 * 1024);
    const lockBytes = await readWorkerFile(path.join(control, 'lock/owner.json'), 65536, { privateMode: true });
    const stateBytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
    if (!same(JSON.parse(lockBytes), lock) || !same(JSON.parse(stateBytes), state)) throw new Error('Publication authority changed.');
    const directory = path.join(control, `first-runtime-${lock.operationId}`);
    bridge = windowsControllerTransport({
      pwsh, refused, label: 'Native first-runtime publisher',
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Project', project, '-Control', control, '-TaskName', observed.taskName,
        '-Node', node, '-Port', String(port), '-LockSha256', digest(lockBytes), '-StateSha256', digest(stateBytes),
        '-ControllerPid', String(process.pid), '-ControllerIdentity', lock.processIdentity],
    });
    await bridge.wire.send({ id: 1, method: 'publish', environment: startup });
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'directory', 'configuration', 'sha256'], 'first runtime');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== lock.processIdentity
      || typeof ready.processIdentity !== 'string' || !ready.processIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid) || ready.directory !== directory
      || ready.configuration !== path.join(directory, 'configuration.json')
      || typeof ready.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ready.sha256)) {
      throw new Error('Original first-runtime publication differs.');
    }
    const bundle = Object.freeze({ directory, configuration: ready.configuration, sha256: ready.sha256 });
    const bytes = await readWorkerFile(bundle.configuration, 1024 * 1024, { privateMode: true });
    const published = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (digest(bytes) !== bundle.sha256 || !same(published.command, {
      file: node, args: [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], cwd: project, environment: startup,
    })) throw new Error('Published first-runtime command differs.');
    await authority(signal);
    await assertWindowsFirstInstallScope(scope, { fresh: false, signal });
    let sequence = 1;
    let busy = false;
    let failure;
    let registered = false;
    let registering = false;
    const request = async (method, requestSignal, options = {}) => {
      if (busy || closed) throw failure ?? refused(new Error('Original first-runtime publication is busy or closed.'));
      busy = true;
      try {
        if (method !== 'close') await authority(requestSignal);
        const id = ++sequence;
        await bridge.wire.send({ id, method, ...options });
        const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'processIdentity', 'value'], 'first-runtime reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity
          || method !== 'register-task' && reply.value !== method) {
          throw new Error('Unexpected first-runtime acknowledgement.');
        }
        if (method === 'register-task') {
          const task = captureWorkerFields(reply.value, [
            'status', 'runtimeAuthority', 'project', 'operationId', 'taskName', 'accountSid', 'logonType', 'triggerType',
            'controllerPid', 'controllerIdentity', 'configuration', 'configurationSha256', 'definition', 'permanentDefinition',
            'securityDescriptor', 'taskFileSha256', 'taskFileDev', 'taskFileIno', 'taskFileSecurityDescriptor',
          ], 'first-task registration');
          if (task.status !== 'first-task-prepared' || task.runtimeAuthority !== false || task.project !== project
            || task.operationId !== lock.operationId || task.taskName !== observed.taskName || task.accountSid !== observed.accountSid
            || task.logonType !== options.logonType || task.triggerType !== options.triggerType
            || task.controllerPid !== ready.pid || task.controllerIdentity !== ready.processIdentity
            || task.configuration !== bundle.configuration || task.configurationSha256 !== bundle.sha256
            || typeof task.taskFileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.taskFileSha256)
            || ![task.taskFileDev, task.taskFileIno].every(value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value))
            || ![task.definition, task.permanentDefinition, task.securityDescriptor, task.taskFileSecurityDescriptor]
              .every(value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0'))) {
            throw new Error('First-task registration differs from the original publisher.');
          }
          await authority(requestSignal);
          return Object.freeze(task);
        }
        if (method === 'close') {
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('First-runtime publisher did not close cleanly.');
          closed = true;
          bridge.wire.close();
        }
      } catch (cause) {
        closed = true;
        failure = await bridge.abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    return Object.freeze({
      status: 'runtime-prepared', runtimeAuthority: false, bundle,
      checkFiles: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      registerTask: async ({ logonType = 'Interactive', triggerType = 'AtLogOn', signal: requestSignal } = {}) => {
        if (closed || busy || registered || registering || !['Interactive', 'S4U'].includes(logonType)
          || !['AtLogOn', 'AtStartup'].includes(triggerType)) {
          throw refused(new Error('Unsupported, repeated or unavailable first-task registration.'));
        }
        registering = true;
        try {
          await assertWindowsFirstInstallScope(scope, { fresh: false, signal: requestSignal });
          const task = await request('register-task', requestSignal, { logonType, triggerType });
          registered = true;
          return task;
        } finally { registering = false; }
      },
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    if (!bridge) throw refused(cause);
    closed = true;
    throw await bridge.abandon(cause);
  }
}
