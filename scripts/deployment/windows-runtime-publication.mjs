import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { requireNoServiceMaintenance, validateState } from './state.mjs';
import { inspectWindowsWorkerScope } from './windows-worker-scope.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-runtime-publication.ps1', import.meta.url));
function refused(cause) {
  return Object.assign(new Error('Windows runtime publication refused; retain any incomplete bundle and the original deployment.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED', runtimeAuthority: false,
  });
}

export async function prepareWindowsRuntimeBundle({ scope, control, lock: suppliedLock, node, pwsh, signal }) {
  signal?.throwIfAborted();
  let bridge;
  try {
    const { root, lock, observation, check } = await inspectWindowsWorkerScope({
      scope, control, lock: suppliedLock, node, pwsh, signal,
    });
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lock.operationId)) {
      throw new Error('Runtime publication requires an explicit deployment operation UUID.');
    }
    const stateFile = path.join(root, 'state.json');
    const stateBytes = await readWorkerFile(stateFile, 65536, { privateMode: true });
    const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes)));
    if (state.project !== lock.project || state.operationId !== lock.operationId || state.startedAt !== lock.createdAt
      || !['deploy', 'update'].includes(state.operation) || state.phase !== 'preflight' || state.previousPhase !== null
      || state.priorRuntime !== 'running' || state.runtimeIdentity !== observation.runtime.generation || state.errorCode !== null) {
      throw new Error('Runtime publication requires the original running preflight state.');
    }
    const authority = async () => {
      signal?.throwIfAborted();
      await requireNoServiceMaintenance(root);
      await check({ signal });
      if (!(await readWorkerFile(stateFile, 65536, { privateMode: true })).equals(stateBytes)) {
        throw new Error('Original runtime publication state changed.');
      }
    };
    await authority();
    const directory = path.join(root, `runtime-${lock.operationId}`);
    const configuration = path.join(directory, 'configuration.json');
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original runtime publisher identity is unavailable.');
    bridge = windowsControllerTransport({
      pwsh, refused, label: 'Native runtime publisher',
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Configuration', observation.configuration,
        '-Sha256', observation.configurationSha256, '-Directory', directory,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
    });
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'directory', 'configuration', 'sha256'], 'runtime publication');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid)
      || ready.directory !== directory || ready.configuration !== configuration || ready.sha256 !== observation.configurationSha256) {
      throw new Error('Original native runtime publication differs.');
    }
    await authority();
    await bridge.wire.send({ id: 1, method: 'close' });
    const reply = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 30000 }),
      ['id', 'type', 'value', 'processIdentity'], 'runtime publication close');
    if (reply.id !== 1 || reply.type !== 'reply' || reply.value !== 'close' || reply.processIdentity !== ready.processIdentity) {
      throw new Error('Unexpected runtime publication close acknowledgement.');
    }
    const result = await bridge.waitForExit();
    if (result.code !== 0 || result.signal !== null) throw new Error('Native runtime publisher did not close cleanly.');
    bridge.wire.close();
    await authority();
    return Object.freeze({ directory, configuration, sha256: observation.configurationSha256 });
  } catch (cause) {
    throw bridge ? await bridge.abandon(cause) : refused(cause);
  }
}
