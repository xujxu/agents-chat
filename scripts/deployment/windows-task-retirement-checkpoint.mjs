import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureWindowsRetiredRuntime } from './windows-managed-task-observation.mjs';
import {
  captureWindowsTaskRetirement, captureRetirementFile, captureRetirementCreator,
  captureRetirementProcess, canonicalRetirementPath,
} from './windows-task-retirement-record.mjs';

export function captureWindowsTaskRetirementCheckpoint(value) {
  const result = captureWorkerFields(value, ['status', 'descriptor', 'intent', 'checkpoint'], 'retirement checkpoint result');
  const intent = captureWindowsTaskRetirement(result.intent);
  const inactive = intent.intent.version === 2;
  const checkpoint = captureWorkerFields(result.checkpoint, [
    'version', 'intent', 'configuration', 'definitionSha256', 'securityDescriptorSha256',
    'enabled', 'listener', 'retiredBridge', 'retiredOwner', 'creator',
    ...(inactive ? ['priorRuntime'] : []),
  ], 'retirement checkpoint');
  const original = captureRetirementFile(checkpoint.intent, 'task-retirement.json');
  const listener = captureWorkerFields(checkpoint.listener,
    ['pid', 'processIdentity', 'createdAt', 'address', 'pairedRecords'], 'retirement listener');
  captureRetirementProcess({ pid: listener.pid, processIdentity: listener.processIdentity });
  if (result.status !== 'prepared' || checkpoint.version !== intent.intent.version
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
  const retiredOwner = captureRetirementProcess(checkpoint.retiredOwner);
  let priorRuntime;
  if (inactive) {
    const prior = captureWorkerFields(checkpoint.priorRuntime, ['configuration', 'runtime'], 'inactive prior runtime');
    const runtime = captureWindowsRetiredRuntime(prior.runtime);
    if (!canonicalRetirementPath(prior.configuration)
      || path.win32.basename(prior.configuration) !== 'configuration.json'
      || prior.configuration.toLowerCase() === checkpoint.configuration.toLowerCase()
      || runtime.pid !== retiredOwner.pid || runtime.identity !== retiredOwner.processIdentity
      || runtime.generation === intent.intent.completion.runtime.generation
      || runtime.identity === intent.intent.completion.runtime.identity || checkpoint.enabled !== false) {
      throw new Error('Inactive retirement checkpoint lost its original retired runtime.');
    }
    priorRuntime = Object.freeze({ configuration: prior.configuration, runtime });
  }
  return Object.freeze({ status: result.status,
    descriptor: captureRetirementFile(result.descriptor, 'task-retirement-checkpoint.json'),
    intent, checkpoint: Object.freeze({ ...checkpoint, intent: original, listener,
      retiredBridge: captureRetirementProcess(checkpoint.retiredBridge),
      retiredOwner, ...(inactive ? { priorRuntime } : {}),
      creator: captureRetirementCreator(checkpoint.creator) }) });
}
