import path from 'node:path';
import { lstat, rename } from 'node:fs/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { externalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';

const fields = ['source', 'build', 'dependencies', 'config', 'service'];
const fileIdentity = info => ({ dev: String(info.dev), ino: String(info.ino) });
function captureIdentity(value) {
  const record = captureWorkerFields(value, fields, 'deployment identity');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.source ?? '')
    || fields.slice(1).some(key => !/^[a-f0-9]{64}$/.test(record[key] ?? ''))) {
    throw new Error('Invalid deployment receipt identity.');
  }
  return record;
}

function captureReceipt(value, project) {
  const record = captureWorkerFields(value,
    ['version', 'project', 'operationId', 'status', 'acceptedAt', 'identity'], 'deployment receipt');
  if (record.version !== 1 || record.project !== project || record.status !== 'accepted'
    || typeof record.operationId !== 'string' || !record.operationId || record.operationId.length > 4096
    || /[\0\r\n]/.test(record.operationId) || typeof record.acceptedAt !== 'string'
    || !Number.isFinite(Date.parse(record.acceptedAt))) {
    throw new Error('Invalid deployment receipt project or acceptance.');
  }
  return Object.freeze({ ...record, identity: captureIdentity(record.identity) });
}

async function observe(file) {
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const bytes = await readWorkerFile(file, 8192, { privateMode: true });
  const after = await lstat(file, { bigint: true });
  if (!same(fileIdentity(info), fileIdentity(after)) || info.size !== after.size
    || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) {
    throw new Error('Deployment receipt file changed during observation.');
  }
  return { identity: fileIdentity(after), bytes: bytes.toString('base64') };
}

function decode(observed, project) {
  return captureReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.from(observed.bytes, 'base64'))), project);
}

export async function readDeploymentReceipt(control, project) {
  const { root } = await externalWorkerDirectory(control, project);
  const observed = await observe(path.join(root, 'deployment.json'));
  return observed === null ? null : decode(observed, project);
}

export function publishDeploymentReceipt(options) {
  return publishReceipt(options, false);
}

export function publishRestoredDeploymentReceipt(options) {
  return publishReceipt(options, true);
}

async function publishReceipt({ control, lock: supplied, identity, checkAccepted, signal }, restored) {
  signal?.throwIfAborted();
  const lock = captureLockOwner(supplied);
  const expected = captureIdentity(identity);
  if (typeof checkAccepted !== 'function') throw new Error('Deployment receipt requires fresh accepted runtime checks.');
  const { root } = await externalWorkerDirectory(control, lock.project);
  const original = fileIdentity(await lstat(root, { bigint: true }));
  const state = await loadState(root);
  if (!state || (restored
    ? state.phase !== 'restored' || state.operation !== 'restore' || state.previousPhase !== 'restore-activating' || state.errorCode !== null
    : state.phase !== 'accepted' || state.operation === 'restore')
    || state.project !== lock.project || state.operationId !== lock.operationId || state.targetCommit !== expected.source) {
    throw new Error(`Deployment receipt requires matching ${restored ? 'restored' : 'accepted'} state and source.`);
  }
  const stateFile = path.join(root, 'state.json');
  const stateEvidence = await observe(stateFile);
  const check = async () => {
    signal?.throwIfAborted();
    await externalWorkerDirectory(root, lock.project);
    if (!same(fileIdentity(await lstat(root, { bigint: true })), original)) throw new Error('Deployment control identity changed.');
    await assertLockOwner(root, lock);
    if (!same(await loadState(root), state) || !same(await observe(stateFile), stateEvidence)) {
      throw new Error('Accepted deployment state changed.');
    }
    if (!same(captureIdentity(await checkAccepted({ signal })), expected)) {
      throw new Error('Accepted deployment identity changed.');
    }
    signal?.throwIfAborted();
    await assertLockOwner(root, lock);
    if (!same(fileIdentity(await lstat(root, { bigint: true })), original)
      || !same(await observe(stateFile), stateEvidence)) throw new Error('Accepted deployment state changed during verification.');
  };
  await check();
  const receipt = captureReceipt({
    version: 1, project: lock.project, operationId: lock.operationId, status: 'accepted',
    acceptedAt: state.updatedAt, identity: expected,
  }, lock.project);
  const destination = path.join(root, 'deployment.json');
  const stage = path.join(root, '.deployment.json.staging');
  const previous = await observe(destination);
  if (previous) decode(previous, lock.project);
  let staged = await observe(stage);
  if (staged) {
    try {
      if (!same(decode(staged, lock.project), receipt)) throw new Error('Foreign receipt.');
    } catch (cause) { throw new Error('Staged deployment receipt is incomplete or foreign; retain it for recovery.', { cause }); }
  }
  if (previous && same(decode(previous, lock.project), receipt) && !staged) {
    await check();
    if (!same(await observe(destination), previous)) throw new Error('Deployment receipt changed.');
    return receipt;
  }
  if (!staged) {
    await writeWorkerFile(stage, Buffer.from(`${JSON.stringify(receipt)}\n`));
    await syncWorkerDirectory(root);
    staged = await observe(stage);
    if (!staged || !same(decode(staged, lock.project), receipt)) throw new Error('Staged deployment receipt changed.');
  }
  await check();
  if (!same(await observe(stage), staged) || !same(await observe(destination), previous)) {
    throw new Error('Deployment receipt publication paths changed.');
  }
  await rename(stage, destination);
  await syncWorkerDirectory(root);
  await check();
  if (!same(await observe(destination), staged)) throw new Error('Published deployment receipt changed.');
  return receipt;
}
