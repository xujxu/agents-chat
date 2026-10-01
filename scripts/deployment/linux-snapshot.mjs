import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { createSnapshot } from './snapshot.mjs';
import { inspectGitMetadata } from './git-metadata.mjs';

export async function createLinuxServiceSnapshot({
  service, stopped, configuration, destination, id, source, signal, recoveryEngine,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('Linux service snapshot requires Linux runtime evidence.');
  const project = service.identity.runtime.project;
  const checkRuntime = async () => {
    signal?.throwIfAborted();
    const state = await stopped.checkStopped();
    if (state.stopped !== true || state.inhibited !== true) throw new Error('Snapshot requires the original stopped service.');
    await service.checkPolicy({ inhibited: true, stopped: true });
    await configuration.checkFiles({ signal });
  };
  await checkRuntime();
  let hasGit = true;
  try { await lstat(path.join(project, '.git')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasGit = false; }
  const gitMetadata = hasGit ? await inspectGitMetadata({ project, commit: source.commit, signal }) : undefined;
  const scope = await inspectSnapshotScope({ project, signal });
  const external = new Map(service.identity.sources.map(file => [file.path, { path: file.path, optional: false }]));
  for (const file of configuration.files) {
    const relative = path.relative(project, file.path);
    if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) continue;
    if (!external.has(file.path)) external.set(file.path, { path: file.path, optional: !file.present });
  }
  return createSnapshot({
    project, destination, id, source, signal, ...scope, gitMetadata, recoveryEngine, externalFiles: [...external.values()],
    runtime: { platform: 'linux', state: 'stopped', unit: service.identity.runtime.unit,
      uid: service.identity.runtime.uid, gid: service.identity.runtime.gid,
      user: service.identity.runtime.user, home: service.identity.runtime.home,
      executables: service.identity.executables },
    async checkSource() {
      await checkRuntime();
      await scope.check({ signal });
    },
  });
}
