import { createHash } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureLockOwner, loadState, validateState } from './state.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

export const coldRetirementMarker = 'service-cold-retirement.json';
export const coldCompletionMarker = 'cold-restore-complete.json';
export const coldStateStage = '.cold-restore-state.json';
export const coldDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const coldIdentity = info => ({ dev: info.dev, ino: info.ino });
export const coldParse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export const coldSerialize = value => Buffer.from(`${JSON.stringify(value)}\n`);
export const coldGuardFiles = ['activation-intent.json', 'activation-ready.json', 'files-restored.json', 'owner.json'];

export async function coldFileDescriptor(file) {
  const bytes = await readWorkerFile(file, 4 * 1024 * 1024, { privateMode: true });
  const info = await lstat(file);
  return { file, ...coldIdentity(info), bytes: bytes.length, sha256: coldDigest(bytes) };
}

export function coldRetirementPaths(control, held, workers) {
  return [
    held, path.join(control, 'service-activation.ndjson'), path.join(control, 'service-stop.ndjson'),
    ...(workers?.files ?? []), ...(workers ? [path.join(control, 'worker-engine')] : []),
    path.join(control, 'lock/owner.json'), path.join(control, 'lock'),
    ...coldGuardFiles.map(name => path.join(control, 'recovery-lock', name)),
    path.join(control, 'recovery-lock'),
  ];
}

export async function captureColdRetirementEntries(control, held, workers) {
  const directories = new Set([path.join(control, 'lock'), path.join(control, 'recovery-lock'), path.join(control, 'worker-engine')]);
  return Promise.all(coldRetirementPaths(control, held, workers).map(async file => {
    if (!directories.has(file)) return { kind: 'file', ...await coldFileDescriptor(file) };
    const { info } = await canonicalWorkerDirectory(file, { privateMode: true });
    return { kind: 'directory', file, ...coldIdentity(info), names: (await readdir(file)).sort() };
  }));
}

export function parseColdRetirement(bytes, control, project, backup) {
  const proof = captureWorkerFields(coldParse(bytes), [
    'version', 'project', 'backup', 'root', 'names', 'lock', 'lease', 'intent', 'ready',
    'oldState', 'oldStateFile', 'state', 'workers', 'entries',
  ], 'cold retirement proof');
  const lock = captureLockOwner(proof.lock);
  const owner = captureLockOwner(proof.lease?.owner);
  const { intent, ready, state, oldState, lease } = proof;
  validateState(oldState);
  validateState(intent?.state);
  validateState(state);
  const unit = ready?.runtime?.runtime?.unit;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (proof.version !== 1 || proof.project !== project || proof.backup !== path.resolve(backup)
    || lock.project !== project || owner.project !== project || owner.token === lock.token
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)
    || ready.runtime.runtime.project !== project
    || !same(lease.lock, lock) || !same(lease.state, oldState) || lease.project !== project || lease.backup !== proof.backup
    || !same(intent?.lock, lock) || !same(intent?.owner, owner)
    || !same(ready.lock, lock) || !same(ready.owner, owner)
    || ready.phase !== 'ready-to-commit' || ready.backupId !== lease.backupId
    || ready.snapshotSha256 !== lease.snapshotSha256 || ready.activationSha256 !== coldDigest(coldSerialize(intent))
    || oldState?.operationId !== lock.operationId || oldState.project !== project
    || intent.state?.operation !== 'restore' || intent.state.phase !== 'restore-activating'
    || intent.state.project !== project || intent.state.operationId !== lock.operationId
    || intent.state.backupId !== lease.backupId
    || !same(state, { ...intent.state, phase: 'restored', previousPhase: 'restore-activating', updatedAt: state?.updatedAt })
    || !Number.isFinite(Date.parse(state.updatedAt))
    || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535
    || !Array.isArray(ready.providers) || !ready.providers.length
    || !ready.providers.every(provider => typeof provider === 'string')) {
    throw new Error('Cold retirement proof does not bind the admitted restoration.');
  }
  const held = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf.${lock.token}.held`;
  const directory = value => {
    captureWorkerFields(value, ['dev', 'ino'], 'cold retirement directory');
    if (!Object.values(value).every(number => Number.isSafeInteger(number) && number >= 0)) {
      throw new Error('Invalid cold retirement directory identity.');
    }
  };
  directory(proof.root);
  if (!same(proof.root, lease.controlIdentity)) throw new Error('Cold retirement root does not match lease.');
  let workers = null;
  if (proof.workers !== null) {
    workers = captureWorkerFields(proof.workers, ['manifestSha256', 'engineIdentity', 'files'], 'cold retirement workers');
    if (!/^[a-f0-9]{64}$/.test(workers.manifestSha256) || !Array.isArray(workers.files)
      || workers.files.length > workerEngineFiles.length + 34) throw new Error('Invalid cold retirement worker inventory.');
    const journals = workers.files.filter(file => typeof file === 'string' && path.dirname(file) === control
      && file.startsWith(path.join(control, 'worker-')) && file.endsWith('.ndjson')
      && uuid.test(path.basename(file).slice(7, -7)));
    const expected = [...journals, ...[...workerEngineFiles, 'manifest.json'].sort()
      .map(name => path.join(control, 'worker-engine', name)), path.join(control, 'worker-operation.ndjson')];
    if (!same(workers.files, expected) || new Set(expected).size !== expected.length) {
      throw new Error('Cold retirement worker paths are not allowlisted.');
    }
  }
  const paths = coldRetirementPaths(control, held, workers);
  const directories = new Set(['lock', 'recovery-lock', ...(workers ? ['worker-engine'] : [])].map(name => path.join(control, name)));
  if (!Array.isArray(proof.entries) || !same(proof.entries.map(entry => entry?.file), paths)) {
    throw new Error('Cold retirement deletion inventory is not allowlisted.');
  }
  const file = entry => {
    directory({ dev: entry.dev, ino: entry.ino });
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 4 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid cold retirement file descriptor.');
  };
  for (const entry of proof.entries) {
    const isDirectory = directories.has(entry.file);
    captureWorkerFields(entry, isDirectory ? ['kind', 'file', 'dev', 'ino', 'names']
      : ['kind', 'file', 'dev', 'ino', 'bytes', 'sha256'], 'cold retirement entry');
    if (entry.kind !== (isDirectory ? 'directory' : 'file')) throw new Error('Cold retirement entry type changed.');
    if (isDirectory) {
      directory({ dev: entry.dev, ino: entry.ino });
      const children = paths.filter(file => path.dirname(file) === entry.file).map(file => path.basename(file)).sort();
      if (!same(entry.names, children)) throw new Error('Cold retirement directory inventory changed.');
    } else file(entry);
  }
  captureWorkerFields(proof.oldStateFile, ['file', 'dev', 'ino', 'bytes', 'sha256'], 'cold old state');
  file(proof.oldStateFile);
  if (proof.oldStateFile.file !== path.join(control, 'state.json')
    || !Array.isArray(proof.names) || proof.names.some(name => typeof name !== 'string'
      || !name || path.basename(name) !== name || ['.', '..', coldRetirementMarker, coldStateStage, coldCompletionMarker].includes(name))
    || new Set(proof.names).size !== proof.names.length) throw new Error('Invalid cold retirement root inventory.');
  return { ...proof, held };
}

export async function retireCompletedColdReceipt(control, project) {
  const file = path.join(control, coldCompletionMarker);
  const bytes = await readWorkerFile(file, 4 * 1024 * 1024, { privateMode: true });
  const info = coldIdentity(await lstat(file));
  const proof = parseColdRetirement(bytes, control, project, coldParse(bytes)?.backup);
  const expectedNames = proof.names.filter(name =>
    !proof.entries.some(entry => entry.file === path.join(control, name)));
  expectedNames.push(coldCompletionMarker);
  const check = async () => {
    if (!same(coldIdentity((await canonicalWorkerDirectory(control, { privateMode: true })).info), proof.root)
      || !same(await loadState(control), proof.state)
      || !same((await readdir(control)).sort(), expectedNames.sort())
      || !same(coldIdentity(await lstat(file)), info)
      || !(await readWorkerFile(file, 4 * 1024 * 1024, { privateMode: true })).equals(bytes)) {
      throw new Error('Completed cold recovery receipt or terminal state changed.');
    }
    for (const entry of proof.entries) {
      try { await lstat(entry.file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Cold recovery cleanup is incomplete or retired evidence reappeared.');
    }
  };
  await check();
  await unlink(file);
  await syncWorkerDirectory(control);
}
