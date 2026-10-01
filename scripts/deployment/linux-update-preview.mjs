import { lstat, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { inspectInstalledLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { inspectLinuxPreviewSource } from './linux-preview-source.mjs';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { prepareGitObjects } from './git-objects.mjs';
import { estimateRequiredBytes } from './snapshot.mjs';
import { previewUpdate } from './update-policy.mjs';
import { runStage } from './stage-runner.mjs';
import { reconcileInterruptedOperation } from './state.mjs';

export async function previewLinuxUpdate({ options, project, control, unit, existing, signal }) {
  return runStage('preview', async stageSignal => {
    let service;
    let result;
    const errors = [];
    try {
      service = await inspectInstalledLinuxService({ unit, project });
      const configuration = await inspectLinuxConfiguration({ service, profile: 'agents-chat-auth-638c553', signal: stageSignal });
      const { source, target } = await inspectLinuxPreviewSource({ project, options, signal: stageSignal });
      const scope = await inspectSnapshotScope({ project, signal: stageSignal });
      const objects = await prepareGitObjects({ project, commit: source.record.commit, signal: stageSignal });
      let externalBytes = 0;
      const external = new Set([...service.identity.sources, ...configuration.files]
        .map(file => file.path).filter(file => !file.startsWith(`${project}${path.sep}`)));
      for (const file of external) {
        stageSignal.throwIfAborted();
        try { externalBytes += (await lstat(file)).size; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const backupBytes = scope.snapshotBytes + objects.bytes + externalBytes;
      const metadataBytes = 80 * 1024 ** 2;
      const buildBytes = 2 * 1024 ** 3;
      const requiredBytes = estimateRequiredBytes({ snapshotBytes: backupBytes, metadataBytes, deploymentBytes: buildBytes });
      const backupParent = existing ? control : path.dirname(control);
      const [projectSpace, backupSpace, projectInfo, backupInfo] = await Promise.all([
        statfs(project, { bigint: true }), statfs(backupParent, { bigint: true }),
        stat(project, { bigint: true }), stat(backupParent, { bigint: true }),
      ]);
      const operation = existing ? await reconcileInterruptedOperation(control) : { status: 'unmanaged', phase: null };
      result = await previewUpdate(options, {
        inspect: async () => ({
          project, sourceCommit: source.record.commit, sourceRef: source.record.ref,
          runtime: { unit, state: service.identity.runtime.activeState },
          operation: { status: operation.status, phase: existing?.state?.phase ?? null },
        }),
        localTarget: async () => target,
        estimate: async () => ({
          backupLocation: path.join(control, 'backup'), backupBytes, metadataBytes, buildBytes, requiredBytes,
          sameFileSystem: projectInfo.dev === backupInfo.dev,
          availableProjectBytes: String(projectSpace.bavail * projectSpace.bsize),
          availableBackupBytes: String(backupSpace.bavail * backupSpace.bsize),
        }),
        checks: async () => [
          ...['current-runtime', 'installed-configuration', 'local-source-identity'].map(name => ({ name, status: 'passed' })),
          ...['source-cleanliness', 'target-admission', 'database-compatibility', 'capacity-recheck', 'readiness',
            ...(!['unmanaged', 'idle', 'already-current', 'preflight-refused', 'prior-runtime-restored'].includes(operation.status)
              ? ['operation-recovery'] : [])].map(name => ({ name, status: 'pending' })),
        ],
      });
      await source.check({ signal: stageSignal });
      await scope.check({ signal: stageSignal });
      await configuration.check({ signal: stageSignal });
      await service.check();
    } catch (error) { errors.push(error); }
    try { await service?.close(); }
    catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Preview inspection and cleanup failed.');
    return { ...result, steps: ['admission', 'stop', 'snapshot', 'select-source',
      ...(options.noInstall ? [] : ['dependencies']), 'build', 'activate', 'verify'] };
  }, { timeoutMs: Math.min(options.timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
}
