import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { runRestore } from './restore-transaction.mjs';
import { admitLinuxRestore } from './linux-restore-compatibility.mjs';
import { restoreProjectSnapshot } from './restore-project.mjs';
import { restoreExternalSnapshot } from './restore-external.mjs';
import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { stopLinuxService } from './linux-service-stop.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';
import { assertLockOwner, captureLockOwner, loadState, releaseLock, writeState } from './state.mjs';
import { externalWorkerDirectory, syncWorkerDirectory } from './worker-files.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function runLinuxLiveRestore({
  service, configuration, control, lock: suppliedLock, backup, port, acceptDataLoss,
  waitSeconds = 120, timeoutSeconds = 1800, signal,
}) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Live Linux restoration requires a root controller.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Restore readiness requires a valid explicit port.');
  const lock = captureLockOwner(suppliedLock);
  const project = service.identity.runtime.project;
  const native = {
    unit: service.identity.runtime.unit, project,
    npm: service.identity.executables[0].file, node: service.identity.executables[1].file,
  };
  let state;
  let initialState;
  let admission;
  let stopped;
  let active;
  let activationAttempted = false;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(control, project);
    if (lock.project !== project) throw new Error('Restore lock project differs from inspected runtime.');
    await assertLockOwner(control, lock);
    if ((state !== undefined || initialState !== undefined)
      && !same(await loadState(control), state ?? initialState)) {
      throw journalUncertain(new Error('Restore transaction state changed.'));
    }
  };
  const checkStopped = async () => {
    await authority();
    if (!stopped) throw journalUncertain(new Error('Restore stop authority is not available.'));
    return stopped.checkStopped();
  };
  try {
    result = await runRestore({ operation: 'restore', acceptDataLoss, waitSeconds, timeoutSeconds, signal }, {
      async inspect() {
        await authority();
        initialState = await loadState(control);
        await service.check();
        return { exists: true, running: true, owned: true };
      },
      async inspectBackup({ signal: stageSignal }) {
        await authority();
        admission = await admitLinuxRestore({ service, configuration, backup, signal: stageSignal });
        return admission;
      },
      async capacity({ snapshot, signal: stageSignal }) {
        await authority();
        const budgets = new Map();
        const add = async (directory, bytes) => {
          stageSignal.throwIfAborted();
          const space = await statfs(directory, { bigint: true });
          const { dev } = await stat(directory, { bigint: true });
          const prior = budgets.get(dev) ?? { bytes: 0n, available: space.bavail * space.bsize };
          prior.bytes += BigInt(bytes);
          budgets.set(dev, prior);
        };
        const bytes = snapshot.entries.reduce((total, entry) => total + (entry.bytes ?? 0), snapshot.gitObjects?.bytes ?? 0);
        if (!Number.isSafeInteger(bytes)) throw new Error('Restore capacity exceeds safe byte range.');
        await add(project, bytes);
        for (const entry of snapshot.externalFiles) await add(path.dirname(entry.path), entry.bytes ?? 0);
        if ([...budgets.values()].some(value => value.bytes > value.available)) throw new Error('Insufficient space for restoration.');
      },
      async record(phase, context) {
        await authority();
        const next = {
          version: 1, operationId: lock.operationId, project, operation: 'restore',
          phase, previousPhase: state?.phase ?? null,
          sourceCommit: null, targetCommit: context.snapshot?.source.commit ?? null,
          backupId: context.snapshot?.id ?? null, priorRuntime: 'running',
          runtimeIdentity: service.identity.runtime.invocationId,
          startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
        };
        await writeState(control, next);
        state = next;
        await syncWorkerDirectory(control);
      },
      async stop({ recovering }) {
        await authority();
        if (recovering) {
          if (!stopped) throw journalUncertain(new Error('Original restore stop did not complete.'));
          if (activationAttempted) return stopped.stopActivated();
          return stopped.checkStopped();
        }
        stopped = await stopLinuxService({ ...native, control, lock });
      },
      async restoreFiles({ signal: stageSignal }) {
        await authority();
        return restoreProjectSnapshot({
          project, backup, acceptDataLoss, checkStopped, signal: stageSignal, expectedSnapshot: admission.snapshot,
        });
      },
      async configure({ signal: stageSignal }) {
        await authority();
        return restoreExternalSnapshot({
          project, backup, acceptDataLoss, authorizedPaths: admission.authorizedPaths, checkStopped, signal: stageSignal,
          expectedSnapshot: admission.snapshot,
        });
      },
      async start() {
        await authority();
        activationAttempted = true;
        await stopped.activate({ purpose: 'restore' });
        active = await inspectLinuxService(native);
      },
      async verify({ signal: stageSignal }) {
        await authority();
        const restoredConfiguration = await inspectLinuxConfiguration({
          service: active, profile: configuration.profile, signal: stageSignal,
        });
        await waitLinuxReadiness({
          service: active, port, providers: restoredConfiguration.providers, waitSeconds, signal: stageSignal,
        });
        await restoredConfiguration.check({ signal: stageSignal });
        await authority();
      },
    });
    await authority();
    await stopped.retire();
    await releaseLock(control, lock);
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled([active?.close(), stopped?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw journalUncertain(new AggregateError(errors, 'Linux restoration and authority cleanup failed.'));
  return result;
}
