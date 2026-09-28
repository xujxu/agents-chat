import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectConfigurationFiles } from './configuration-files.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';

export async function inspectSnapshotConfiguration({
  backup, snapshot, profile, environment, systemdFiles = [], signal,
}) {
  signal?.throwIfAborted();
  const { root } = await canonicalWorkerDirectory(backup, { privateMode: true });
  const original = await verifySnapshot(root, { signal });
  if (!same(original, snapshot) || snapshot.scope !== 'project') {
    throw new Error('Saved configuration requires the admitted complete project snapshot.');
  }
  const files = path.join(root, 'files');
  if (!Array.isArray(systemdFiles) || systemdFiles.length > 32) throw new Error('Invalid saved configuration source inventory.');
  const mapped = systemdFiles.map(source => {
    if (!source || typeof source.path !== 'string' || !path.isAbsolute(source.path)
      || path.resolve(source.path) !== source.path || /[\0\r\n]/.test(source.path)
      || typeof source.optional !== 'boolean') throw new Error('Invalid saved configuration source.');
    const relative = path.relative(snapshot.project, source.path);
    const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (inside) {
      const name = relative.split(path.sep).join('/');
      if (!name || snapshot.excludedPaths.some(excluded => name === excluded || name.startsWith(`${excluded}/`))) {
        throw new Error('Saved configuration source is excluded from the snapshot.');
      }
      return { path: path.join(files, relative), optional: source.optional };
    }
    const index = snapshot.externalFiles.findIndex(entry => entry.path === source.path);
    if (index < 0) throw new Error('External configuration source was not captured in the snapshot.');
    return { path: path.join(root, 'external', String(index)), optional: source.optional };
  });
  const inspected = await inspectConfigurationFiles({
    project: files, profile, environment, systemdFiles: mapped, signal,
  });
  const check = async ({ signal: checkSignal = signal } = {}) => {
    checkSignal?.throwIfAborted();
    if (!same(await verifySnapshot(root, { signal: checkSignal }), original)) {
      throw new Error('Admitted saved configuration snapshot changed.');
    }
    await inspected.check({ signal: checkSignal });
  };
  await check();
  return Object.freeze({ status: inspected.status, profile: inspected.profile, providers: inspected.providers, check });
}
