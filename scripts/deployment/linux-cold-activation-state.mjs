import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';

export function createColdActivationState(record) {
  const priorRuntime = record.state?.priorRuntime;
  const stopped = priorRuntime === 'stopped';
  if (!['running', 'stopped'].includes(priorRuntime)
    || typeof record.runtimeIdentity !== 'string'
    || !(stopped ? /^stopped:[a-f0-9]{64}$/ : /^[a-f0-9]{32}$/).test(record.runtimeIdentity)
    || stopped && record.runtimeIdentity !== record.state.runtimeIdentity
    || typeof record.targetCommit !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.targetCommit)) {
    throw new Error('Invalid original cold activation identity or target commit.');
  }
  return {
    version: stopped ? 2 : 1,
    state: {
      version: 1, operationId: record.lock.operationId, project: record.project, operation: 'restore',
      phase: 'restore-activating', previousPhase: 'restoring', sourceCommit: record.state.sourceCommit,
      targetCommit: record.targetCommit, backupId: record.backupId, priorRuntime,
      runtimeIdentity: record.runtimeIdentity,
      startedAt: record.owner.createdAt, updatedAt: record.owner.createdAt, errorCode: null,
    },
  };
}

export function captureColdActivationIntent(value, record) {
  const intent = captureWorkerFields(value, ['version', 'owner', 'lock', 'state'], 'cold activation intent');
  const expected = createColdActivationState({
    ...record, targetCommit: intent.state?.targetCommit, runtimeIdentity: intent.state?.runtimeIdentity,
  });
  if (!same(intent, { version: expected.version, owner: record.owner, lock: record.lock, state: expected.state })) {
    throw new Error('Cold activation intent does not match the retained lease.');
  }
  return intent;
}
