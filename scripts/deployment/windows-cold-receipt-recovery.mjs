import { isDeepStrictEqual as same } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';
import { openWindowsColdReceiptAuthority, assertWindowsColdReceiptAuthority } from './windows-cold-activation-recovery.mjs';
import { publishWindowsColdRestoredDeploymentReceipt, readDeploymentReceipt } from './deployment-receipt.mjs';

export async function recoverWindowsColdRestoredDeploymentReceipt({
  control, pwsh, acceptDataLoss, profile = 'agents-chat-auth-638c553', waitSeconds = 120, signal, onProgress, expectedSnapshot,
} = {}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Cold receipt recovery requires explicit data-loss acknowledgement.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('Invalid cold receipt progress callback.');
  const resources = [];
  const failures = [];
  let result;
  try {
    const authority = await openWindowsColdReceiptAuthority({ control, pwsh, acceptDataLoss, signal, expectedSnapshot });
    resources.push(authority);
    const { state, lock, observation: completed } = authority;
    const project = state.project;
    const scope = await inspectWindowsManagedTask({ project, taskName: completed.taskName, pwsh, signal });
    resources.push(scope);
    if (!same(scope.observation.runtime, completed.runtime) || scope.observation.lease !== 'released') {
      throw new Error('Original restored cold runtime differs.');
    }
    const configuration = await inspectWindowsConfiguration({ scope, pwsh, profile, signal });
    resources.push(configuration);
    if (!same(configuration.providers, completed.providers)) throw new Error('Original restored authentication differs.');
    const source = await inspectGitMetadata({ project, commit: state.targetCommit, signal });
    const artifacts = await inspectBuildArtifacts({ project, signal });
    const accepted = await captureWindowsDeploymentAcceptance({
      scope, configuration, source, artifacts, port: completed.port, waitSeconds, signal,
    });
    const receipt = await publishWindowsColdRestoredDeploymentReceipt({
      control, authority, lock, ...accepted, signal,
      onProgress: onProgress && (progress => onProgress(Object.freeze({
        ...progress, runtime: completed.runtime, lease: 'released',
      }))),
    });
    if (!same(await accepted.checkAccepted({ signal }), receipt.identity)
      || !same(await readDeploymentReceipt(control, project), receipt)) {
      throw new Error('Published restored cold deployment acceptance changed.');
    }
    await assertWindowsColdReceiptAuthority({ control, lock, authority, signal });
    result = Object.freeze({
      status: 'cold-restored-receipt-published', operationId: lock.operationId,
      receipt, runtime: completed.runtime, lease: 'released',
    });
  } catch (error) { failures.push(error); }
  for (const resource of resources.reverse()) {
    try { await resource.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    throw Object.assign(new Error('Cold restored receipt recovery refused; retain original recovery evidence.', {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Cold receipt recovery and cleanup failed.'),
    }), { code: 'DEPLOYMENT_WINDOWS_COLD_RECEIPT_RECOVERY_REFUSED', recoveryAllowed: false });
  }
  return result;
}
