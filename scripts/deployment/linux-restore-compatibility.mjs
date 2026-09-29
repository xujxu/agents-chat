import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { verifySnapshot } from './snapshot.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { inspectLinuxRestoreConfiguration } from './linux-configuration.mjs';

const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);

export function assertColdRestoreNative(identity, expected) {
  if (expected && (identity?.runtime?.unit !== expected.unit || identity?.executables?.[0]?.file !== expected.npm
    || identity?.executables?.[1]?.file !== expected.node)) {
    throw new Error('Saved cold restore input does not match the retained native service identity.');
  }
}

export function validateLinuxRestoreSnapshot({ identity, manifest, authorizedPaths }) {
  const { runtime, sources, executables } = identity;
  if (executables.some(entry => inside(runtime.project, entry.file) || inside(runtime.project, entry.target))) {
    throw new Error('Recovery runtime executables must be outside the mutable project.');
  }
  if (manifest.project !== runtime.project || manifest.scope !== 'project'
    || manifest.runtime.platform !== 'linux'
    || ['unit', 'uid', 'gid', 'user', 'home'].some(key => manifest.runtime[key] !== runtime[key])
    || !same(manifest.runtime.executables, executables)) {
    throw new Error('Saved restore scope, service identity or Node/npm executables differ from the installed runtime.');
  }
  if (!same((manifest.externalFiles ?? []).map(file => file.path).sort(), authorizedPaths)) {
    throw new Error('Saved external paths do not match native service configuration authority.');
  }
  for (const source of sources) {
    const file = manifest.externalFiles.find(entry => entry.path === source.path);
    if (file?.kind !== 'file' || file.sha256 !== source.sha256 || file.bytes !== source.size
      || file.uid !== source.uid || file.gid !== source.gid || file.mode !== (source.mode & 0o777)) {
      throw new Error('Restoring changed unit policy requires a separate native policy transition.');
    }
  }
}

export async function admitLinuxRestore({ service, configuration, backup, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('Native restore admission requires Linux.');
  const { runtime, sources } = service.identity;
  const saved = (await canonicalWorkerDirectory(backup, { privateMode: true })).root;
  if (inside(runtime.project, saved) || inside(saved, runtime.project)) {
    throw new Error('Restore backup must be outside the installed project.');
  }
  const authorizedPaths = [...new Set([
    ...sources.map(source => source.path),
    ...configuration.files.filter(file => !inside(runtime.project, file.path)).map(file => file.path),
  ])].sort();
  const inspect = async checkSignal => {
    checkSignal?.throwIfAborted();
    await service.check();
    await configuration.check({ signal: checkSignal });
    const manifest = await verifySnapshot(saved, { signal: checkSignal });
    validateLinuxRestoreSnapshot({ identity: service.identity, manifest, authorizedPaths });
    await inspectLinuxRestoreConfiguration({
      service, backup: saved, snapshot: manifest, profile: configuration.profile, signal: checkSignal,
    });
    await configuration.check({ signal: checkSignal });
    await service.check();
    checkSignal?.throwIfAborted();
    return manifest;
  };
  const snapshot = await inspect(signal);
  return Object.freeze({
    snapshot, authorizedPaths: Object.freeze(authorizedPaths),
    async check({ signal: checkSignal = signal } = {}) {
      if (!same(await inspect(checkSignal), snapshot)) throw new Error('Admitted restore backup changed before downtime.');
    },
  });
}
