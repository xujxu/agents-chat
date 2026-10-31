import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-first-install-controller.ps1', import.meta.url));
const scopes = new WeakMap();
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
function refused(cause) {
  return Object.assign(new Error('Windows first-install inspection refused; no installation was authorized.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED', runtimeAuthority: false,
  });
}
function capture(value, project, taskName) {
  const observed = captureWorkerFields(value, [
    'status', 'runtimeAuthority', 'project', 'taskName', 'accountSid', 'sessionId',
    'dev', 'ino', 'projectSecurityDescriptor',
  ], 'first-install observation');
  if (observed.status !== 'first-install-observed' || observed.runtimeAuthority !== false
    || observed.project !== project || observed.taskName !== taskName
    || typeof observed.accountSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(observed.accountSid)
    || !Number.isSafeInteger(observed.sessionId) || observed.sessionId < 0 || observed.sessionId > 2147483647
    || ![observed.dev, observed.ino].every(id => typeof id === 'string' && /^[0-9]{1,20}$/.test(id))
    || typeof observed.projectSecurityDescriptor !== 'string' || !observed.projectSecurityDescriptor
    || observed.projectSecurityDescriptor.length > 65536 || /[\0\r\n]/.test(observed.projectSecurityDescriptor)) {
    throw new Error('Invalid native first-install observation.');
  }
  return Object.freeze(observed);
}

export async function inspectWindowsFirstInstall({ project, taskName, pwsh, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !canonical(project) || path.dirname(project) === project
    || !canonical(pwsh) || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)) {
    throw refused(new Error('Canonical Windows project, PowerShell and explicit task name are required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original first-install controller identity is unavailable.'));
  const bridge = windowsControllerTransport({
    pwsh, refused, label: 'Native first-install observer',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Project', project, '-TaskName', taskName,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'value'], 'first-install readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || typeof ready.processIdentity !== 'string' || !ready.processIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid)) {
      throw new Error('Original first-install observer differs.');
    }
    const observation = capture(ready.value, project, taskName);
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A first-install observation request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Original first-install observation is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (bridge.child.exitCode !== null || bridge.child.signalCode !== null) throw new Error('Original observer exited.');
        const id = ++sequence;
        await bridge.wire.send({ id, method });
        const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'processIdentity', 'value'], 'first-install reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
          throw new Error('Unexpected first-install observation acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected first-install close acknowledgement.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('First-install observer did not close cleanly.');
          closed = true;
          bridge.wire.close();
          return;
        }
        if (!same(capture(reply.value, project, taskName), observation)) throw new Error('Original first-install identity changed.');
        return observation;
      } catch (cause) {
        closed = true;
        failure = await bridge.abandon(cause);
        throw failure;
      } finally {
        busy = false;
      }
    };
    const scope = Object.freeze({
      identity: Object.freeze({ pwsh, pid: ready.pid, processIdentity: ready.processIdentity }),
      observation,
      checkFresh: ({ signal: requestSignal } = {}) => request('check-fresh', requestSignal),
      checkFreshRuntime: ({ signal: requestSignal } = {}) => request('check-fresh-runtime', requestSignal),
      checkUninstalled: ({ signal: requestSignal } = {}) => request('check-uninstalled', requestSignal),
      close: async () => { if (!closed) await request('close'); },
    });
    scopes.set(scope, request);
    await scope.checkFresh({ signal });
    return scope;
  } catch (cause) {
    if (closed) throw cause;
    closed = true;
    throw await bridge.abandon(cause);
  }
}

export async function assertWindowsFirstInstallScope(scope, { fresh = true, controlEvidence = fresh, signal } = {}) {
  const request = scopes.get(scope);
  if (!request || typeof fresh !== 'boolean' || typeof controlEvidence !== 'boolean' || !fresh && controlEvidence) {
    throw refused(new Error('An original first-install scope and supported observation mode are required.'));
  }
  return request(fresh ? controlEvidence ? 'check-fresh' : 'check-fresh-runtime' : 'check-uninstalled', signal);
}
