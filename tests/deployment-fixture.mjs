import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeState } from '../scripts/deployment/state.mjs';

export async function temporaryDeployment(t) {
  const temporary = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporary, 'agents-deployment-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function acceptOperation(control, lock, operation = 'deploy') {
  const phases = operation === 'restore' ? ['restore-preflight', 'restoring', 'restore-activating', 'restored']
    : ['preflight', 'source-selected', 'dependencies', 'building', 'configuring', 'activating', 'accepted'];
  let previousPhase = null;
  for (const phase of phases) {
    await writeState(control, {
      version: 1, operationId: lock.operationId, project: lock.project, operation, phase, previousPhase,
      sourceCommit: null, targetCommit: 'a'.repeat(40), backupId: null, priorRuntime: 'absent',
      runtimeIdentity: 'retirement-fixture', startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: null,
    });
    previousPhase = phase;
  }
}

export async function recoverPriorRuntime(control, lock) {
  let previousPhase = null;
  for (const phase of ['preflight', 'stopped', 'copying', 'prior-runtime-restored']) {
    await writeState(control, {
      version: 1, operationId: lock.operationId, project: lock.project, operation: 'update', phase, previousPhase,
      sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), backupId: null, priorRuntime: 'running',
      runtimeIdentity: 'retirement-fixture', startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: phase === 'prior-runtime-restored' ? 'BACKUP_FAILED' : null,
    });
    previousPhase = phase;
  }
}
