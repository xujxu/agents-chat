import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';

const digests = ['ownerSha256', 'filesReceiptSha256', 'intentSha256', 'historySha256', 'stateSha256'];
const bindings = ['operationId', 'taskName', ...digests, 'sourceDefinition', 'targetDefinition', 'securityDescriptor'];
const ownerFields = ['controllerPid', 'controllerIdentity', 'bridgePid', 'bridgeIdentity'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerOf = record => Object.fromEntries(ownerFields.map(key => [key, record[key]]));

export function captureWindowsColdPolicyHistory({ binding, records }) {
  const evidenceFields = ['launchSha256', 'preparationSha256'].filter(key => binding && Object.hasOwn(binding, key));
  const bindingFields = [...bindings, ...evidenceFields];
  const fields = ['version', ...bindingFields, 'sequence', 'previousSha256', ...ownerFields, 'kind', 'step'];
  const expected = captureWorkerFields(binding, bindingFields, 'cold policy binding');
  if (evidenceFields.length > 1
    || evidenceFields.includes('preparationSha256') && expected.preparationSha256 !== expected.historySha256
    || typeof expected.operationId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(expected.operationId)
    || typeof expected.taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(expected.taskName)
    || [...digests, ...evidenceFields].some(key => typeof expected[key] !== 'string' || !/^[a-f0-9]{64}$/.test(expected[key]))
    || ['sourceDefinition', 'targetDefinition', 'securityDescriptor'].some(key =>
      typeof expected[key] !== 'string' || !expected[key].length
      || expected[key].length > (key === 'securityDescriptor' ? 65536 : 262144) || expected[key].includes('\0'))) {
    throw new Error('Cold policy history requires its admitted original binding.');
  }
  if (!Array.isArray(records) || records.length > 256) {
    throw new Error('Cold policy history exceeds its record budget.');
  }
  let total = 0;
  for (const bytes of records) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4194304) {
      throw new Error('Cold policy history exceeds its record byte budget.');
    }
    total += bytes.length;
    if (total > 16777216) throw new Error('Cold policy history exceeds its total byte budget.');
  }
  let previousSha256 = expected.historySha256;
  let step = 'initial';
  let owner = null;
  const owners = new Set();
  const captured = [];
  for (const bytes of records) {
    const record = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      fields, 'cold policy recovery record');
    if (record.version !== 1 || record.sequence !== captured.length + 1
      || record.previousSha256 !== previousSha256 || bindingFields.some(key => record[key] !== expected[key])) {
      throw new Error('Cold policy record differs from its original policy, evidence or byte chain.');
    }
    for (const [pid, identity] of [[record.controllerPid, record.controllerIdentity], [record.bridgePid, record.bridgeIdentity]]) {
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 || typeof identity !== 'string'
        || identity.length > 64 || !new RegExp(`^${pid}:[1-9][0-9]*$`).test(identity)) {
        throw new Error('Cold policy recovery owner identity is invalid.');
      }
    }
    if (record.controllerPid === record.bridgePid) throw new Error('Cold policy controller and native bridge must differ.');
    const current = ownerOf(record);
    if (record.kind === 'claim') {
      if (record.step !== step || owners.has(current.controllerIdentity) || owners.has(current.bridgeIdentity)) {
        throw new Error('Cold policy takeover changed its prior step or reused a previous owner.');
      }
      owner = Object.freeze(current);
      owners.add(current.controllerIdentity);
      owners.add(current.bridgeIdentity);
    } else {
      const next = record.kind === 'request' && step === 'initial' ? 'requested'
        : record.kind === 'restored' && step === 'requested' ? 'restored' : null;
      if (!owner || !same(current, owner) || !next || record.step !== next) {
        throw new Error('Cold policy transition requires its claimed owner and original write-ahead step.');
      }
      step = next;
    }
    captured.push(Object.freeze(record));
    previousSha256 = digest(bytes);
  }
  return Object.freeze({
    mutationAuthority: false, step, sequence: captured.length, sha256: previousSha256,
    owner, records: Object.freeze(captured),
  });
}
