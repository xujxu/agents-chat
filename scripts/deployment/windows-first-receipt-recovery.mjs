import { isDeepStrictEqual as same } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { captureWindowsDeploymentAcceptance, windowsServiceIdentityRecord } from './windows-deployment-acceptance.mjs';
import { openWindowsFirstReceiptPublication } from './windows-first-receipt-publication.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';

export async function recoverWindowsFirstDeploymentReceipt({
  control, project, operationId, pwsh, admission, profile = 'agents-chat-auth-638c553', waitSeconds = 120, signal,
}) {
  const resources = [];
  const failures = [];
  let receipt;
  try {
    const publication = await openWindowsFirstReceiptPublication({ control, project, operationId, pwsh, admission, signal });
    resources.push(publication);
    const original = publication.deploymentIdentity;
    const completed = publication.observation;
    const scope = await inspectWindowsManagedTask({ project, taskName: completed.taskName, pwsh, signal });
    resources.push(scope);
    if (!same(scope.observation.runtime, completed.runtime) || !scope.observation.enabled
      || scope.observation.lease !== 'released') throw new Error('Original first runtime differs.');
    const configuration = await inspectWindowsConfiguration({ scope, pwsh, profile, signal });
    resources.push(configuration);
    if (!same(configuration.providers, completed.providers)) throw new Error('Original first authentication differs.');
    const source = await inspectGitMetadata({ project, commit: original.source, signal });
    const artifacts = await inspectBuildArtifacts({ project, signal });
    const accepted = await captureWindowsDeploymentAcceptance({
      scope, configuration, source, artifacts, port: completed.port, waitSeconds, signal,
    });
    const { service, ...identity } = accepted.identity;
    if (!same(identity, original)) throw new Error('Current first deployment differs from its original prepared identity.');
    await publication.check({ signal });
    receipt = await publication.publish({ service: windowsServiceIdentityRecord(scope.observation), signal });
    if (receipt.identity.service !== service || !same(await accepted.checkAccepted({ signal }), receipt.identity)
      || !same(await readDeploymentReceipt(control, project), receipt)) {
      throw new Error('Published first deployment acceptance changed.');
    }
    await publication.check({ signal });
  } catch (error) { failures.push(error); }
  for (const resource of resources.reverse()) {
    try { await resource.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    throw Object.assign(new Error('Cold first deployment receipt recovery refused; retain original evidence.', {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'First receipt recovery and cleanup failed.'),
    }), { code: 'DEPLOYMENT_WINDOWS_FIRST_RECEIPT_RECOVERY_REFUSED', recoveryAllowed: false });
  }
  return receipt;
}
