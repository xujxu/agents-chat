import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { requireNoServiceMaintenance, validateState } from './state.mjs';
import { inspectWindowsWorkerScope } from './windows-worker-scope.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';
import { inspectWindowsRestoreTaskPolicy } from './windows-restore-task-policy.mjs';

const script = fileURLToPath(new URL('./windows-runtime-publication.ps1', import.meta.url));
function refused(cause) {
  return Object.assign(new Error('Windows runtime publication refused; retain any incomplete bundle and the original deployment.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED', runtimeAuthority: false,
  });
}

export function prepareWindowsRuntimeBundle(options) {
  return prepareRuntimeBundle(options, false);
}

export function prepareWindowsRestoreRuntimeBundle(options) {
  return prepareRuntimeBundle(options, true);
}

async function prepareRuntimeBundle({ scope, control, lock: suppliedLock, node, pwsh, signal, backup, snapshot }, restore) {
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
      || (restore ? state.operation !== 'restore' || state.phase !== 'restore-preflight'
        : !['deploy', 'update'].includes(state.operation) || state.phase !== 'preflight')
      || state.previousPhase !== null
      || state.priorRuntime !== 'running' || state.runtimeIdentity !== observation.runtime.generation || state.errorCode !== null) {
      throw new Error('Runtime publication requires the original running preflight state.');
    }
    const archived = restore ? await inspectWindowsSnapshotRuntime({
      backup, snapshot, project: lock.project, taskName: observation.taskName, signal,
    }) : null;
    if (archived) {
      if (state.backupId !== snapshot.id || state.targetCommit !== snapshot.source.commit) {
        throw new Error('Restore publication state does not identify the admitted backup and revision.');
      }
      await inspectWindowsRestoreTaskPolicy({ scope, task: archived.task, pwsh, signal });
    }
    const sourceConfiguration = archived
      ? archived.files.find(file => file.name === 'configuration.json').file : observation.configuration;
    const sha256 = archived ? archived.task.configurationSha256 : observation.configurationSha256;
    const authority = async () => {
      signal?.throwIfAborted();
      await requireNoServiceMaintenance(root);
      await check({ signal });
      await archived?.check({ signal });
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
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Configuration', sourceConfiguration,
        '-Sha256', sha256, '-Directory', directory, ...(restore ? ['-Archived'] : []),
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
    });
    if (archived) await bridge.wire.send({ id: 0, method: 'archive', files: archived.files });
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'directory', 'configuration', 'sha256'], 'runtime publication');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid)
      || ready.directory !== directory || ready.configuration !== configuration || ready.sha256 !== sha256) {
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
    return Object.freeze({ directory, configuration, sha256 });
  } catch (cause) {
    if (!bridge) throw refused(cause);
    const error = await bridge.abandon(cause);
    if (bridge.child.pid && bridge.child.exitCode === null && bridge.child.signalCode === null) {
      throw journalUncertain(error);
    }
    throw error;
  }
}
