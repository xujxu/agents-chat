import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import {
  captureWindowsTaskRetirement, captureRetirementFile, captureRetirementCreator,
  captureRetirementProcess, canonicalRetirementPath,
} from './windows-task-retirement-record.mjs';

export function captureWindowsTaskRetirementCheckpoint(value) {
  const result = captureWorkerFields(value, ['status', 'descriptor', 'intent', 'checkpoint'], 'retirement checkpoint result');
  const intent = captureWindowsTaskRetirement(result.intent);
  const checkpoint = captureWorkerFields(result.checkpoint, [
    'version', 'intent', 'configuration', 'definitionSha256', 'securityDescriptorSha256',
    'enabled', 'listener', 'retiredBridge', 'retiredOwner', 'creator',
  ], 'retirement checkpoint');
  const original = captureRetirementFile(checkpoint.intent, 'task-retirement.json');
  const listener = captureWorkerFields(checkpoint.listener,
    ['pid', 'processIdentity', 'createdAt', 'address', 'pairedRecords'], 'retirement listener');
  captureRetirementProcess({ pid: listener.pid, processIdentity: listener.processIdentity });
  if (result.status !== 'prepared' || checkpoint.version !== 1
    || !isDeepStrictEqual(original, intent.descriptor)
    || !canonicalRetirementPath(checkpoint.configuration)
    || path.win32.basename(checkpoint.configuration) !== 'configuration.json'
    || ![checkpoint.definitionSha256, checkpoint.securityDescriptorSha256]
      .every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
    || typeof checkpoint.enabled !== 'boolean' || typeof listener.pairedRecords !== 'boolean'
    || typeof listener.createdAt !== 'string' || !/^[1-9][0-9]{0,18}$/.test(listener.createdAt)
    || BigInt(listener.createdAt) > 9223372036854775807n
    || !['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1'].includes(listener.address)
    || (listener.pairedRecords && listener.address !== '::')) {
    throw new Error('Invalid native retirement runtime checkpoint.');
  }
  return Object.freeze({ status: result.status,
    descriptor: captureRetirementFile(result.descriptor, 'task-retirement-checkpoint.json'),
    intent, checkpoint: Object.freeze({ ...checkpoint, intent: original, listener,
      retiredBridge: captureRetirementProcess(checkpoint.retiredBridge),
      retiredOwner: captureRetirementProcess(checkpoint.retiredOwner),
      creator: captureRetirementCreator(checkpoint.creator) }) });
}
