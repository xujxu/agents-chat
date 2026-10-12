import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { validateState } from './state.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = text => JSON.parse(text);
const binding = ['operationId', 'taskName', 'stateSha256', 'ownerSha256', 'filesReceiptSha256',
  'intentSha256', 'historySha256', 'completionSha256', 'runtime', 'port', 'providers'];

export async function captureWindowsColdTerminalFiles(control) {
  const files = await Promise.all([
    ['state', 'state.json', 65536], ['lock', 'lock/owner.json', 65536],
    ['transaction', 'task-maintenance/transaction.json', 1048576],
  ].map(async ([name, relative, maximum]) => {
    const file = path.join(control, relative);
    const before = await lstat(file, { bigint: true });
    const bytes = await readWorkerFile(file, maximum, { privateMode: true });
    const after = await lstat(file, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
      throw new Error('Original cold terminal file changed during capture.');
    }
    return [name, Object.freeze({
      dev: after.dev.toString(), ino: after.ino.toString(), bytes: bytes.length, sha256: digest(bytes),
    })];
  }));
  return Object.freeze(Object.fromEntries(files));
}

export function captureWindowsColdTerminalIntent(value, expected) {
  const record = captureWorkerFields(value, [
    'version', 'phase', 'project', ...binding, 'oldState', 'nextState',
    'rootIdentity', 'lockIdentity', 'recoveryIdentity', 'files', 'creator',
  ], 'cold terminal handoff');
  const files = captureWorkerFields(record.files, ['state', 'lock', 'transaction'], 'cold terminal files');
  const creator = captureWorkerFields(record.creator,
    ['pid', 'processIdentity', 'bridgePid', 'bridgeIdentity'], 'cold terminal creator');
  for (const [pid, identity] of [[creator.pid, creator.processIdentity], [creator.bridgePid, creator.bridgeIdentity]]) {
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof identity !== 'string' || identity.length > 64
      || !new RegExp(`^${pid}:[1-9][0-9]*$`).test(identity)) throw new Error('Invalid cold terminal creator.');
  }
  if (creator.pid === creator.bridgePid || record.version !== 1 || record.phase !== 'prepared'
    || record.project !== expected.project
    || binding.some(key => !same(record[key], expected.observation[key]))
    || ['rootIdentity', 'lockIdentity', 'recoveryIdentity', 'files'].some(key => !same(record[key], expected[key]))
    || typeof record.oldState !== 'string' || record.oldState !== expected.oldState
    || digest(Buffer.from(record.oldState)) !== record.stateSha256 || files.state.sha256 !== record.stateSha256
    || files.state.bytes !== Buffer.byteLength(record.oldState)
    || typeof record.nextState !== 'string' || Buffer.byteLength(record.nextState) > 65536) {
    throw new Error('Cold terminal handoff differs from its original evidence.');
  }
  const old = validateState(parse(record.oldState));
  const next = validateState(parse(record.nextState));
  if (!same(next, { ...expected.activationState, phase: 'restored', previousPhase: 'restore-activating',
    updatedAt: next.updatedAt }) || new Date(next.updatedAt).toISOString() !== next.updatedAt
    || Date.parse(next.updatedAt) < Math.max(Date.parse(old.updatedAt), Date.parse(expected.activationState.updatedAt))) {
    throw new Error('Cold terminal handoff changed or backdated its proposed state.');
  }
  return Object.freeze({
    ...record, runtime: Object.freeze({ ...record.runtime }), providers: Object.freeze([...record.providers]),
    creator: Object.freeze({ ...creator }), rootIdentity: Object.freeze({ ...record.rootIdentity }),
    lockIdentity: Object.freeze({ ...record.lockIdentity }), recoveryIdentity: Object.freeze({ ...record.recoveryIdentity }),
    files: Object.freeze(Object.fromEntries(Object.entries(files).map(([key, file]) => [key, Object.freeze({ ...file })]))),
  });
}
