import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { inspectRecoveryEngineFiles, locateRecoveryEngine, readRecoveryEngineManifest, recoveryDigest } from './recovery-engine-files.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const fileIdentity = info => ({ ...identity(info), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });

export async function retireRecoveryEngines({ control, lock: supplied, current, signal }) {
  const lock = captureLockOwner(supplied);
  const root = await canonicalWorkerDirectory(control, { privateMode: true });
  const state = await loadState(control);
  const receipt = await readDeploymentReceipt(control, lock.project);
  if (state?.phase !== 'accepted' || state.operation === 'restore' || state.operationId !== lock.operationId
    || state.project !== lock.project || receipt?.operationId !== lock.operationId
    || receipt.identity.source !== state.targetCommit) throw new Error('Engine retirement requires this accepted deployment.');
  const backup = path.join(control, 'backup');
  const snapshot = await verifySnapshot(backup, { signal });
  if (snapshot.project !== lock.project) throw new Error('Engine retirement backup belongs to another project.');
  const engine = await locateRecoveryEngine({ control, manifestSha256: current.manifestSha256 });
  if (engine !== current.directory) throw new Error('Current recovery engine location changed.');
  await inspectRecoveryEngineFiles({ directory: engine, manifestSha256: current.manifestSha256, signal });
  const retained = await locateRecoveryEngine({ control, manifestSha256: snapshot.recoveryEngine });
  await inspectRecoveryEngineFiles({ directory: retained, manifestSha256: snapshot.recoveryEngine, signal });
  const protectedFiles = [path.join(backup, 'manifest.json'), path.join(backup, 'complete.json')];
  const protectedIdentity = await Promise.all(protectedFiles.map(async file => fileIdentity(await lstat(file))));
  const check = async () => {
    signal?.throwIfAborted();
    await assertLockOwner(control, lock);
    if (!same(identity((await canonicalWorkerDirectory(control, { privateMode: true })).info), identity(root.info))
      || !same(await loadState(control), state)
      || !same(await readDeploymentReceipt(control, lock.project), receipt)
      || !same(await Promise.all(protectedFiles.map(async file => fileIdentity(await lstat(file)))), protectedIdentity)) {
      throw new Error('Engine retirement authority or backup changed.');
    }
    const names = await readdir(control);
    if (names.some(name => name.startsWith('worker-') || name.startsWith('service-')
      || ['recovery-lock', 'staging', 'retiring', 'rotation.json'].includes(name)
      || name.startsWith('recovery-engine') && name.endsWith('.staging'))) {
      throw new Error('Unsettled operation or staging evidence prevents engine retirement.');
    }
  };
  await check();
  const candidates = [];
  for (const name of await readdir(control)) {
    if (!name.startsWith('recovery-engine-') && !name.startsWith('retired-recovery-engine-')) continue;
    const match = /^(retired-)?recovery-engine-([a-f0-9]{64})$/.exec(name);
    if (!match) throw new Error('Unclassified recovery engine evidence.');
    const directory = path.join(control, name);
    const target = path.join(control, `recovery-engine-${match[2]}`);
    if ([engine, retained].includes(target)) {
      if (match[1]) throw new Error('Retired engine is still required by the accepted operation or backup.');
      continue;
    }
    const location = await canonicalWorkerDirectory(directory, { privateMode: true });
    const names = await readdir(directory);
    let manifest;
    if (match[1] && names.length === 0) manifest = null;
    else {
      ({ manifest } = await readRecoveryEngineManifest({ directory, manifestSha256: match[2] }));
      const expected = new Map(manifest.files.map(entry => [entry.name, entry]));
      if (names.some(name => name !== 'manifest.json' && !expected.has(name))
        || !match[1] && names.length !== expected.size + 1) throw new Error('Unexpected engine retirement inventory.');
      for (const name of names.filter(name => name !== 'manifest.json')) {
        const entry = expected.get(name);
        const bytes = await readWorkerFile(path.join(directory, name), 1024 * 1024, { privateMode: true });
        if (bytes.length !== entry.bytes || recoveryDigest(bytes) !== entry.sha256) throw new Error('Engine retirement helper integrity failure.');
      }
    }
    candidates.push({ directory, retired: !!match[1], digest: match[2], info: location.info, manifest });
  }
  for (const candidate of candidates) {
    await check();
    let directory = candidate.directory;
    const checkDirectory = async () => {
      if (!same(identity((await canonicalWorkerDirectory(directory, { privateMode: true })).info), identity(candidate.info))) {
        throw new Error('Retiring engine directory changed.');
      }
    };
    await checkDirectory();
    if (!candidate.retired) {
      const destination = path.join(control, `retired-recovery-engine-${candidate.digest}`);
      try { await lstat(destination); throw new Error('Engine retirement destination already exists.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(directory, destination);
      directory = destination;
      await syncWorkerDirectory(control);
    }
    // The renamed directory is the durable deletion intent; its manifest is removed last.
    for (const entry of candidate.manifest?.files ?? []) {
      await check();
      await checkDirectory();
      const file = path.join(directory, entry.name);
      let bytes;
      try { bytes = await readWorkerFile(file, 1024 * 1024, { privateMode: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (bytes.length !== entry.bytes || recoveryDigest(bytes) !== entry.sha256) throw new Error('Retiring engine helper changed.');
      await unlink(file);
      await syncWorkerDirectory(directory);
    }
    await check();
    await checkDirectory();
    if (candidate.manifest) {
      await readRecoveryEngineManifest({ directory, manifestSha256: candidate.digest });
      if (!same(await readdir(directory), ['manifest.json'])) throw new Error('Retiring engine inventory changed during deletion.');
      await unlink(path.join(directory, 'manifest.json'));
      await syncWorkerDirectory(directory);
    }
    await check();
    await checkDirectory();
    await rmdir(directory);
    await syncWorkerDirectory(control);
  }
}
