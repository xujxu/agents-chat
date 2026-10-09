import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';

export async function inspectCurrentWindowsDeployment({
  state, scope, configuration, control, commit, port, waitSeconds, signal,
}) {
  signal?.throwIfAborted();
  if (!state || !['accepted', 'already-current'].includes(state.phase) || state.targetCommit !== commit) return null;
  const { project } = await assertWindowsManagedTaskScope(scope, { signal });
  if (state.project !== project) throw new Error('Accepted Windows state belongs to another project.');
  const receipt = await readDeploymentReceipt(control, project);
  if (!receipt || receipt.identity.source !== commit
    || state.phase === 'accepted' && receipt.operationId !== state.operationId) return null;
  for (const file of ['.next/BUILD_ID', 'node_modules', 'package-lock.json']) {
    try { await lstat(path.join(project, file)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const source = await inspectGitMetadata({ project, commit, signal });
  const artifacts = await inspectBuildArtifacts({ project, signal });
  if (receipt.identity.build !== artifacts.identity.build
    || receipt.identity.dependencies !== artifacts.identity.dependencies) return null;
  const accepted = await captureWindowsDeploymentAcceptance({
    scope, configuration, source, artifacts, port, waitSeconds, signal,
  });
  if (!same(accepted.identity, receipt.identity)) return null;
  return Object.freeze({
    current: { phase: 'accepted', receipt, observed: { verified: true, running: true, identity: accepted.identity } },
    async check({ signal: checkSignal } = {}) {
      await accepted.checkAccepted({ signal: checkSignal });
      if (!same(await readDeploymentReceipt(control, project), receipt)) {
        throw new Error('Prior Windows deployment receipt changed.');
      }
    },
  });
}
