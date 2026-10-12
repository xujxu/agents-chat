import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function createWindowsColdActivationIntent(record, ownerBytes, receipt, targetCommit) {
  if (record.state.priorRuntime !== 'running'
    || typeof record.state.runtimeIdentity !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.state.runtimeIdentity)
    || record.state.runtimeIdentity === '00000000-0000-0000-0000-000000000000'
    || typeof targetCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(targetCommit)) {
    throw new Error('Invalid original Windows cold activation runtime or target commit.');
  }
  return {
    version: 1, phase: 'activation-intent', ownerSha256: digest(ownerBytes),
    filesReceiptSha256: digest(receipt.bytes), operationId: record.lock.operationId,
    backupId: record.backupId, snapshotSha256: record.snapshotSha256,
    stateSha256: record.stateSha256, runtimeBundle: receipt.record.runtimeBundle,
    state: {
      version: 1, operationId: record.lock.operationId, project: record.project, operation: 'restore',
      phase: 'restore-activating', previousPhase: 'restoring', sourceCommit: record.state.sourceCommit,
      targetCommit, backupId: record.backupId, priorRuntime: 'running',
      runtimeIdentity: record.state.runtimeIdentity, startedAt: record.owner.createdAt,
      updatedAt: record.owner.createdAt, errorCode: null,
    },
  };
}
