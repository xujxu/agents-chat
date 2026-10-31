import path from 'node:path';
import {
  assertWindowsInactiveLostRuntimeAuthority, prepareWindowsInactiveRollbackIntent,
  releaseWindowsInactiveRollbackRuntimeHandoff,
} from './windows-task-completion-recovery.mjs';
import { inspectWindowsInactiveRollbackSnapshot } from './windows-inactive-rollback-snapshot.mjs';
import { restoreProjectSnapshot } from './restore-project.mjs';
import { runStage } from './stage-runner.mjs';

const restoring = new WeakSet();

export async function restoreWindowsInactiveRollbackProject(options) {
  const { control, scope, pwsh, signal, acceptDataLoss, timeoutSeconds = 1800 } = options;
  signal?.throwIfAborted();
  if (acceptDataLoss !== true || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Inactive project rollback requires explicit data-loss acknowledgement and a bounded stage.');
  }
  await assertWindowsInactiveLostRuntimeAuthority(options);
  if (restoring.has(scope)) throw new Error('Inactive project rollback is already in progress.');
  restoring.add(scope);
  try {
    return await runStage('inactive-rollback-project', async stageSignal => {
      const retained = { ...options, signal: stageSignal };
      const binding = await inspectWindowsInactiveRollbackSnapshot(retained);
      const relative = path.relative(binding.snapshot.project, binding.runtime.task.configuration);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        await releaseWindowsInactiveRollbackRuntimeHandoff(retained);
      }
      await prepareWindowsInactiveRollbackIntent(retained);
      await binding.check({ signal: stageSignal });
      const checkStopped = async ({ signal: checkSignal = stageSignal } = {}) => {
        checkSignal.throwIfAborted();
        const observation = await assertWindowsInactiveLostRuntimeAuthority({
          ...retained, signal: checkSignal,
        });
        if (observation.status !== 'inactive-runtime-lost' || observation.phase !== 'release-requested'
          || observation.priorRuntime !== 'stopped') {
          throw new Error('Inactive project rollback lost its original stopped runtime evidence.');
        }
        return { stopped: true, inhibited: true };
      };
      await restoreProjectSnapshot({
        project: binding.snapshot.project, backup: path.join(control, 'backup'),
        expectedSnapshot: binding.snapshot, acceptDataLoss, pwsh,
        checkStopped, signal: stageSignal,
      });
      await binding.check({ signal: stageSignal });
      return Object.freeze({ status: 'project-restored', sourceCommit: binding.snapshot.source.commit });
    }, { signal, timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER) });
  } finally {
    restoring.delete(scope);
  }
}
