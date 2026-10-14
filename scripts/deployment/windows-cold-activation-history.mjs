import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = (bytes, maximum) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
    throw new Error('Cold activation evidence exceeds its byte budget.');
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};
const fields = [
  'version', 'phase', 'operationId', 'ownerSha256', 'filesReceiptSha256', 'intentSha256', 'previousSha256',
  'controllerPid', 'controllerIdentity', 'taskName', 'definition', 'securityDescriptor',
  'configuration', 'configurationSha256', 'runtime',
];

export function captureWindowsColdLaunch({ history, bytes, originalGeneration }) {
  if (history?.phase !== 'start-requested' || history.runtime !== null || history.records?.length !== 1) {
    throw new Error('Cold launch proof requires an unacknowledged original start request.');
  }
  const record = captureWorkerFields(parse(bytes, 65536), [
    'version', 'generation', 'pid', 'identity', 'configurationSha256', 'sessionId', 'job',
    'controllerPid', 'controllerIdentity',
  ], 'cold launch record');
  if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1 || record.pid > 2147483647
    || typeof record.identity !== 'string' || record.identity.length > 64
    || !new RegExp(`^${record.pid}:[1-9][0-9]*$`).test(record.identity)
    || typeof record.generation !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.generation)
    || record.generation === '00000000-0000-0000-0000-000000000000'
    || record.generation === originalGeneration
    || !Number.isSafeInteger(record.sessionId) || record.sessionId < 0 || record.sessionId > 2147483647
    || record.configurationSha256 !== history.records[0].configurationSha256
    || record.job !== `Local\\agents-deploy-${record.generation}`
    || record.controllerPid !== history.controllerPid || record.controllerIdentity !== history.controllerIdentity
    || record.pid === record.controllerPid) {
    throw new Error('Cold launch differs from its original controller, configuration or new runtime identity.');
  }
  return Object.freeze({ record: Object.freeze(record), sha256: digest(bytes) });
}

export function captureWindowsColdActivationHistory({ intent, intentBytes, records, taskName }) {
  if (!same(parse(intentBytes, 65536), intent) || intent.version !== 1 || intent.phase !== 'activation-intent'
    || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)
    || !Array.isArray(records) || records.length < 1 || records.length > 3) {
    throw new Error('Cold activation history requires its admitted intent and a bounded prefix.');
  }
  const intentSha256 = digest(intentBytes);
  let previousSha256 = intentSha256;
  const captured = [];
  for (const bytes of records) {
    const record = captureWorkerFields(parse(bytes, 4194304), fields, 'cold activation record');
    const previous = captured.at(-1);
    const expected = {
      version: 1, operationId: intent.operationId, ownerSha256: intent.ownerSha256,
      filesReceiptSha256: intent.filesReceiptSha256, intentSha256, previousSha256, taskName,
      configuration: intent.runtimeBundle.configuration, configurationSha256: intent.runtimeBundle.sha256,
    };
    if (Object.entries(expected).some(([key, value]) => record[key] !== value)
      || !Number.isSafeInteger(record.controllerPid) || record.controllerPid < 1 || record.controllerPid > 2147483647
      || typeof record.controllerIdentity !== 'string' || record.controllerIdentity.length > 64
      || !new RegExp(`^${record.controllerPid}:[1-9][0-9]*$`).test(record.controllerIdentity)
      || typeof record.definition !== 'string' || !record.definition.length || record.definition.length > 262144
      || record.definition.includes('\0') || typeof record.securityDescriptor !== 'string'
      || !record.securityDescriptor.length || record.securityDescriptor.length > 65536
      || /[\0\r\n]/.test(record.securityDescriptor)
      || previous && ['controllerPid', 'controllerIdentity', 'securityDescriptor']
        .some(key => record[key] !== previous[key])) {
      throw new Error('Cold activation record differs from its original owner, intent, task or bridge.');
    }
    if (!previous ? record.phase !== 'start-requested'
      : previous.phase === 'start-requested' ? !['running', 'stopped'].includes(record.phase)
        : previous.phase !== 'running' || record.phase !== 'stopped') {
      throw new Error('Cold activation journal has an unsupported phase prefix.');
    }
    if (record.phase === 'start-requested' && record.runtime !== null
      || record.phase === 'running' && record.runtime === null) {
      throw new Error('Cold activation phase has no matching runtime identity.');
    }
    const runtime = record.runtime === null ? null : Object.freeze(captureActivatedRuntime(record.runtime));
    if (runtime && (runtime.configurationSha256 !== intent.runtimeBundle.sha256
      || runtime.generation === intent.state.runtimeIdentity || runtime.pid === record.controllerPid)
      || previous?.phase === 'running' && !same(runtime, previous.runtime)) {
      throw new Error('Cold activation changed its original new runtime.');
    }
    captured.push(Object.freeze({ ...record, runtime }));
    previousSha256 = digest(bytes);
  }
  const last = captured.at(-1);
  return Object.freeze({
    mutationAuthority: false, phase: last.phase, sha256: previousSha256,
    controllerPid: last.controllerPid, controllerIdentity: last.controllerIdentity,
    runtime: last.runtime, records: Object.freeze(captured),
  });
}
