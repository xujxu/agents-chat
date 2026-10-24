import path from 'node:path';
import {
  assertWindowsInactiveLostRuntimeAuthority, prepareWindowsInactiveRollbackIntent,
} from './windows-task-completion-recovery.mjs';
import { inspectWindowsInactiveRollbackSnapshot } from './windows-inactive-rollback-snapshot.mjs';
import { publishWindowsRuntimeBundle } from './windows-runtime-publication.mjs';
import { inspectWindowsRuntimeRelocation } from './windows-runtime-relocation.mjs';
import { restoreExternalSnapshot } from './restore-external.mjs';
import { runStage } from './stage-runner.mjs';

const restoring = new WeakSet();

export async function restoreWindowsInactiveRollbackExternal(options) {
  const { control, scope, pwsh, signal, acceptDataLoss, timeoutSeconds = 1800 } = options;
  signal?.throwIfAborted();
  if (acceptDataLoss !== true || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Inactive external rollback requires explicit data-loss acknowledgement and a bounded stage.');
  }
  await assertWindowsInactiveLostRuntimeAuthority(options);
  if (restoring.has(scope)) throw new Error('Inactive external rollback is already in progress.');
  restoring.add(scope);
  try {
    return await runStage('inactive-rollback-external', async stageSignal => {
      const retained = { ...options, signal: stageSignal };
      const binding = await inspectWindowsInactiveRollbackSnapshot(retained);
      await prepareWindowsInactiveRollbackIntent(retained);
      const check = () => binding.check({ signal: stageSignal });
      await check();
      const directory = path.join(control, 'inactive-rollback-runtime');
      const backup = path.join(control, 'backup');
      const runtimeBundle = await publishWindowsRuntimeBundle({
        directory,
        sourceConfiguration: binding.runtime.files.find(file => file.name === 'configuration.json').file,
        sha256: binding.runtime.task.configurationSha256,
        archiveFiles: binding.runtime.files, pwsh, signal: stageSignal, check, resumeExisting: true,
      });
      const checkStopped = async ({ signal: checkSignal = stageSignal } = {}) => {
        checkSignal.throwIfAborted();
        const observation = await assertWindowsInactiveLostRuntimeAuthority({
          ...retained, signal: checkSignal,
        });
        if (observation.status !== 'inactive-runtime-lost' || observation.phase !== 'release-requested'
          || observation.priorRuntime !== 'stopped') {
          throw new Error('Inactive external rollback lost its original stopped runtime evidence.');
        }
        return { stopped: true, inhibited: true };
      };
      await restoreExternalSnapshot({
        project: binding.snapshot.project, backup, expectedSnapshot: binding.snapshot,
        authorizedPaths: binding.authorizedPaths, runtimeBundle, acceptDataLoss, pwsh,
        checkStopped, signal: stageSignal,
      });
      const relocation = await inspectWindowsRuntimeRelocation({
        project: binding.snapshot.project, backup, snapshot: binding.snapshot,
        runtimeBundle, signal: stageSignal,
      });
      await relocation.verify();
      await check();
      return Object.freeze({ status: 'external-restored', runtimeBundle });
    }, { signal, timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  } finally {
    restoring.delete(scope);
  }
}
