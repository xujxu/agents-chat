import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { captureTaskListener, windowsTaskCompletionSteps } from './windows-task-controller.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export const windowsColdCompletionPhases = Object.freeze(windowsTaskCompletionSteps.filter(step => ![
  'policy-applied', 'lease-released', 'permanent-policy-applied', 'enable-applied',
].includes(step)));
const phases = windowsColdCompletionPhases;
const bindingFields = [
  'operationId', 'ownerSha256', 'filesReceiptSha256', 'intentSha256', 'historySha256', 'stateSha256',
  'controllerPid', 'controllerIdentity', 'runtime', 'taskName', 'configuration', 'configurationSha256',
  'guardedDefinition', 'stagedDefinition', 'permanentDefinition', 'targetEnabled', 'securityDescriptor',
  'port', 'providers', 'listenerPid', 'listenerIdentity', 'listenerAddress', 'listenerCreatedAt', 'listenerPairedRecords',
];

export async function captureWindowsColdCompletionPrefix({
  control, running, ownerSha256, receiptSha256, intentSha256, port, providers, phase: finalPhase, signal,
}) {
  signal?.throwIfAborted();
  if (!phases.includes(finalPhase)) throw new Error('Unsupported cold completion receipt phase.');
  const directory = path.join(control, 'recovery-lock');
  const intentBytes = await readWorkerFile(path.join(directory, 'activation-intent.json'), 65536, { privateMode: true });
  if (digest(intentBytes) !== intentSha256) throw new Error('Cold completion intent changed.');
  const intent = parse(intentBytes);
  const historyBytes = await readWorkerFile(path.join(directory, 'activation-running.json'), 4194304, { privateMode: true });
  const expected = {
    operationId: intent.operationId, ownerSha256, filesReceiptSha256: receiptSha256, intentSha256,
    historySha256: digest(historyBytes), stateSha256: intent.stateSha256,
    controllerPid: running.controllerPid, controllerIdentity: running.controllerIdentity,
    runtime: running.runtime, taskName: running.taskName, configuration: running.configuration,
    configurationSha256: running.runtime.configurationSha256, guardedDefinition: running.definition,
    securityDescriptor: running.securityDescriptor, port, providers,
  };
  let previousSha256 = expected.historySha256;
  let binding;
  let previous;
  for (const phase of phases.slice(0, phases.indexOf(finalPhase) + 1)) {
    signal?.throwIfAborted();
    const bytes = await readWorkerFile(path.join(directory, `completion-${phase}.json`), 1048576, { privateMode: true });
    const record = captureWorkerFields(parse(bytes),
      ['version', 'phase', 'previousSha256', ...bindingFields, 'definition', 'enabled', 'lease'], 'cold completion receipt');
    const current = Object.fromEntries(bindingFields.map(key => [key, record[key]]));
    if (record.version !== 1 || record.phase !== phase || record.previousSha256 !== previousSha256
      || Object.entries(expected).some(([key, expectedValue]) => !same(record[key], expectedValue))
      || binding && !same(current, binding)
      || typeof record.targetEnabled !== 'boolean'
      || ['stagedDefinition', 'permanentDefinition', 'definition'].some(key =>
        typeof record[key] !== 'string' || !record[key].length || record[key].length > 262144 || record[key].includes('\0'))
      || record.enabled !== (phase === 'complete' ? record.targetEnabled : false)
      || record.lease !== (phases.indexOf(phase) >= phases.indexOf('released') ? 'released' : 'guarded')) {
      throw new Error('Cold runtime completion differs from its original binding or write-ahead progression.');
    }
    captureTaskListener({
      status: 'retained', generation: running.runtime.generation, port,
      pid: record.listenerPid, identity: record.listenerIdentity, address: record.listenerAddress,
      createdAt: record.listenerCreatedAt, pairedRecords: record.listenerPairedRecords,
    }, running.runtime, port);
    if (phase === 'prepared' && record.definition !== running.definition
      || previous && !['policy-staged', 'policy-restored', 'complete'].includes(phase)
        && record.definition !== previous.definition
      || phase === 'complete' && !record.targetEnabled && record.definition !== previous.definition) {
      throw new Error('Cold runtime policy changed outside its acknowledged registration boundary.');
    }
    binding ??= current;
    previous = record;
    previousSha256 = digest(bytes);
  }
  return Object.freeze({
    sha256: previousSha256,
    record: Object.freeze({ ...previous, runtime: Object.freeze({ ...previous.runtime }),
      providers: Object.freeze([...previous.providers]) }),
  });
}

export async function captureWindowsColdRuntimeCompletion({
  control, running, ownerSha256, receiptSha256, intentSha256, port, providers, value, signal,
}) {
  signal?.throwIfAborted();
  const result = captureWorkerFields(value, [
    'status', 'step', 'lease', 'completionSha256', 'runtime', 'taskName', 'configuration',
    'definition', 'enabled', 'port', 'providers',
  ], 'cold runtime completion');
  const prefix = await captureWindowsColdCompletionPrefix({
    control, running, ownerSha256, receiptSha256, intentSha256, port, providers, phase: 'complete', signal,
  });
  if (!same(result, {
    status: 'runtime-policy-restored', step: 'complete', lease: 'released', completionSha256: prefix.sha256,
    runtime: running.runtime, taskName: running.taskName, configuration: running.configuration,
    definition: prefix.record.definition, enabled: prefix.record.enabled, port, providers,
  })) throw new Error('Cold runtime completion acknowledgement differs from its retained journal.');
  return Object.freeze({ ...result, runtime: Object.freeze({ ...result.runtime }), providers: Object.freeze([...providers]) });
}
