import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';
import { captureLinuxDeploymentAcceptance } from './linux-deployment-acceptance.mjs';

export async function inspectCurrentLinuxDeployment({
  state, service, configuration, control, commit, port, waitSeconds, signal,
}) {
  if (!state || !['accepted', 'already-current'].includes(state.phase) || state.targetCommit !== commit) return null;
  const project = service.identity.runtime.project;
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
  const accepted = await captureLinuxDeploymentAcceptance({
    service, configuration, source, artifacts, port, waitSeconds, signal,
  });
  if (!same(accepted.identity, receipt.identity)) return null;
  return Object.freeze({
    current: { phase: 'accepted', receipt, observed: { verified: true, running: true, identity: accepted.identity } },
    async check({ signal: checkSignal } = {}) {
      await accepted.checkAccepted({ signal: checkSignal });
      if (!same(await readDeploymentReceipt(control, project), receipt)) throw new Error('Prior deployment receipt changed.');
    },
  });
}
