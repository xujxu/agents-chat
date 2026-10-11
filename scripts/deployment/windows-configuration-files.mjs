import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-configuration-files.ps1', import.meta.url));
const names = ['.env.production.local', '.env.local', '.env.production', '.env', 'agents.json'];
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const security = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\0\r\n]/.test(value);
function refused(cause) {
  return Object.assign(new Error('Windows configuration file observation refused; retain original files and permissions.', { cause }),
    { code: 'DEPLOYMENT_WINDOWS_CONFIGURATION_REFUSED' });
}
function capture(value, project, configuration, sha256) {
  const record = captureWorkerFields(value,
    ['project', 'configuration', 'configurationSha256', 'projectSecurityDescriptor', 'projectFileSecurityDescriptor', 'files'],
    'configuration file observation');
  if (record.project !== project || record.configuration !== configuration || record.configurationSha256 !== sha256
    || !security(record.projectSecurityDescriptor) || !security(record.projectFileSecurityDescriptor)
    || !Array.isArray(record.files) || record.files.length !== names.length) {
    throw new Error('Unexpected configuration observation scope.');
  }
  const files = record.files.map((value, index) => {
    const file = captureWorkerFields(value,
      ['path', 'present', 'sha256', 'bytes', 'dev', 'ino', 'securityDescriptor'], 'configuration source');
    if (file.path !== path.join(project, names[index]) || typeof file.present !== 'boolean') {
      throw new Error('Unexpected configuration source path.');
    }
    if (file.present) {
      if (!digest(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 * 1024
        || ![file.dev, file.ino].every(value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value))
        || !security(file.securityDescriptor)) throw new Error('Invalid retained configuration metadata.');
    } else if (['sha256', 'bytes', 'dev', 'ino', 'securityDescriptor'].some(key => file[key] !== null)) {
      throw new Error('Absent configuration cannot claim retained metadata.');
    }
    return Object.freeze(file);
  });
  return Object.freeze({ ...record, files: Object.freeze(files) });
}

export async function openWindowsConfigurationFiles({ project, configuration, sha256, pwsh, signal }) {
  return openConfigurationFiles({ project, configuration, sha256, pwsh, signal, fresh: false });
}

export async function openWindowsFirstConfigurationFiles({ project, pwsh, signal }) {
  return openConfigurationFiles({ project, configuration: null, sha256: null, pwsh, signal, fresh: true });
}

async function openConfigurationFiles({ project, configuration, sha256, pwsh, signal, fresh }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![project, pwsh].every(canonical)
    || (!fresh && (!canonical(configuration) || path.basename(configuration) !== 'configuration.json' || !digest(sha256)))) {
    throw refused(new Error('Canonical Windows configuration scope is required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original configuration observer identity is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native configuration file observer',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Project', project,
      ...(fresh ? ['-FreshInstallation'] : ['-Configuration', configuration, '-Sha256', sha256]),
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'value'], 'configuration observer readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) throw new Error('Original configuration observer differs.');
    const observation = capture(ready.value, project, configuration, sha256);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A configuration observation request is active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Configuration observation is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original configuration observer exited.');
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'processIdentity', 'value'], 'configuration observer reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected configuration observer acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected configuration close acknowledgement.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Configuration observer close failed.');
          closed = true;
          wire.close();
          return;
        }
        if (!isDeepStrictEqual(capture(reply.value, project, configuration, sha256), observation)) {
          throw new Error('Original configuration metadata changed.');
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
