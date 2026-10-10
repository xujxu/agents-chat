import { isDeepStrictEqual as same } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { windowsConfigurationIdentity } from './windows-deployment-acceptance.mjs';
import { captureWindowsFirstDeploymentIdentity } from './windows-first-deployment-identity.mjs';
import { openWindowsFirstCompletionRecovery } from './windows-first-completion-recovery.mjs';

export async function completeWindowsFirstDeployment({
  control, project, operationId, stateSha256, pwsh, admission, signal,
}) {
  const resources = [];
  const failures = [];
  try {
    const recovery = await openWindowsFirstCompletionRecovery({ control, pwsh, admission, signal });
    resources.push(recovery);
    const original = recovery.observation;
    if (recovery.project !== project || original.operationId !== operationId || original.stateSha256 !== stateSha256) {
      throw new Error('Cold first completion differs from the original accepted operation.');
    }
    if (original.status !== 'complete') {
      if (!recovery.deploymentIdentity) throw new Error('Cold first completion requires original prepared provenance.');
      const scope = await inspectWindowsManagedTask({ project, taskName: original.taskName, pwsh, signal });
      resources.push(scope);
      if (!same(scope.observation.runtime, original.runtime) || scope.observation.lease !== 'released') {
        throw new Error('Original released first runtime differs.');
      }
      const configuration = await inspectWindowsConfiguration({
        scope, pwsh, profile: 'agents-chat-auth-638c553', signal,
      });
      resources.push(configuration);
      if (!same(configuration.providers, original.providers)) throw new Error('Original first authentication differs.');
      const source = await inspectGitMetadata({ project, commit: recovery.deploymentIdentity.source, signal });
      const artifacts = await inspectBuildArtifacts({ project, signal });
      const current = captureWindowsFirstDeploymentIdentity({
        source: source.record.commit, build: artifacts.identity.build, dependencies: artifacts.identity.dependencies,
        config: windowsConfigurationIdentity(configuration),
      });
      if (!same(current, recovery.deploymentIdentity)) {
        throw new Error('Current first deployment differs from its original prepared identity.');
      }
      // The observer freezes the old task definition; policy recovery must not reuse it.
      await scope.close();
      resources.splice(resources.indexOf(scope), 1);
      const checkFiles = async () => {
        await configuration.checkFiles({ signal });
        await source.check({ signal });
        await artifacts.check({ signal });
      };
      while (recovery.observation.status !== 'complete') {
        await checkFiles();
        await recovery.advance({ signal });
      }
      await checkFiles();
    }
    await recovery.check({ signal });
  } catch (error) { failures.push(error); }
  for (const resource of resources.reverse()) {
    try { await resource.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    throw Object.assign(new Error('Cold first completion refused; retain original runtime and operation evidence.', {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Cold first completion and cleanup failed.'),
    }), { code: 'DEPLOYMENT_WINDOWS_FIRST_COLD_COMPLETION_REFUSED', recoveryAllowed: false });
  }
}
