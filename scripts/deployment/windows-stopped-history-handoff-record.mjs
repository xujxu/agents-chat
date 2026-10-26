import { createHash } from 'node:crypto';
import path from 'node:path';
import { captureLockOwner, validateState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureWindowsInactiveTaskObservation } from './windows-managed-task-observation.mjs';

const guid = value => typeof value === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

function captureIdentity(input) {
  const value = captureWorkerFields(input, ['dev', 'ino'], 'handoff identity');
  if (typeof value.dev !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value.dev)
    || typeof value.ino !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.ino)
    || BigInt(value.dev) > 4294967295n || BigInt(value.ino) > 18446744073709551615n) {
    throw new Error('Invalid stopped history handoff identity.');
  }
  return value;
}

function captureDescriptor(input, name, maximumBytes = 65536) {
  const value = captureWorkerFields(input, ['path', 'dev', 'ino', 'bytes', 'sha256'],
    'handoff descriptor');
  captureIdentity({ dev: value.dev, ino: value.ino });
  if (value.path !== name || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > maximumBytes
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Invalid stopped history handoff descriptor.');
  }
  return value;
}

export function captureWindowsStoppedHistoryHandoffPreparedDescriptor(input, attemptId) {
  if (!guid(attemptId)) throw new Error('Invalid stopped history handoff attempt.');
  return captureDescriptor(input, `inactive-handoff-${attemptId}-prepared.json`, 1048576);
}

export function captureWindowsStoppedHistoryHandoffPrepared(input) {
  const record = captureWorkerFields(input, [
    'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity',
    'previousOperationId', 'operation', 'oldState', 'state', 'intent',
    'completion', 'newOwner', 'observation',
  ], 'prepared history handoff');
  if (record.version !== 1 || record.phase !== 'stopped-history-handoff-prepared'
    || !guid(record.attemptId) || !guid(record.previousOperationId)
    || !canonical(record.control) || !canonical(record.project)
    || !['deploy', 'update'].includes(record.operation)
    || typeof record.oldState !== 'string' || Buffer.byteLength(record.oldState) > 65536) {
    throw new Error('Invalid prepared stopped history handoff.');
  }
  const controlIdentity = captureIdentity(record.controlIdentity);
  const state = captureDescriptor(record.state, 'state.json');
  const intent = captureDescriptor(record.intent,
    `retired-${record.previousOperationId}-inactive-rollback-history-intent.json`);
  const completion = captureDescriptor(record.completion,
    `retired-${record.previousOperationId}-inactive-rollback-history-complete.json`);
  const prior = validateState(JSON.parse(record.oldState));
  const newOwner = captureLockOwner(record.newOwner);
  const observation = captureWindowsInactiveTaskObservation(record.observation,
    record.project, record.observation?.taskName);
  if (state.bytes !== Buffer.byteLength(record.oldState)
    || state.sha256 !== createHash('sha256').update(record.oldState).digest('hex')
    || prior.project !== record.project || prior.operationId !== record.previousOperationId
    || prior.operation !== 'update' || prior.phase !== 'restored'
    || prior.previousPhase !== 'accepted' || prior.priorRuntime !== 'stopped'
    || prior.errorCode !== null || prior.sourceCommit === null || prior.targetCommit === null
    || prior.backupId === null || prior.runtimeIdentity !== observation.retiredRuntime.generation
    || newOwner.project !== record.project || !guid(newOwner.operationId)
    || new Set([record.attemptId, record.previousOperationId, newOwner.operationId]).size !== 3
    || !new RegExp(`^${newOwner.pid}:[1-9][0-9]*$`).test(newOwner.processIdentity)
    || Date.parse(newOwner.createdAt) < Date.parse(prior.updatedAt)) {
    throw new Error('Stopped history handoff differs from its original evidence.');
  }
  return Object.freeze({ ...record, controlIdentity, state, intent, completion, newOwner, observation });
}
