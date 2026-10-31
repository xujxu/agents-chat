import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectWindowsInactiveRollbackSnapshot } from './windows-inactive-rollback-snapshot.mjs';
import { inspectWindowsRuntimeRelocation } from './windows-runtime-relocation.mjs';
import { inventorySnapshot, assertSnapshotAbsent, fileDigest } from './snapshot-files.mjs';
import { projectSnapshotExclusions } from './snapshot-scope.mjs';
import { inspectGitMetadata, gitSourceMetadata } from './git-metadata.mjs';
import { readSnapshotGit } from './snapshot-git.mjs';
import { inspectWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from './windows-restore-security.mjs';

export async function verifyWindowsInactiveRollbackFiles(options) {
  const { control, runtimeBundle, signal, pwsh } = options;
  const binding = await inspectWindowsInactiveRollbackSnapshot(options);
  const { snapshot } = binding;
  const backup = path.join(control, 'backup');
  const directory = path.join(control, 'inactive-rollback-runtime');
  if (!same(runtimeBundle, {
    directory, configuration: path.join(directory, 'configuration.json'),
    sha256: binding.runtime.task.configurationSha256,
  })) throw new Error('Files-restored receipt requires the original rollback runtime destination.');
  const relocation = await inspectWindowsRuntimeRelocation({
    project: snapshot.project, backup, snapshot, runtimeBundle, signal,
  });
  const check = async () => {
    await binding.check({ signal });
    await relocation.verify();
    await assertSnapshotAbsent(snapshot.project, snapshot.absentPaths);
    const names = (await readdir(snapshot.project)).sort().filter(name => !projectSnapshotExclusions.includes(name));
    const entries = names.length ? await inventorySnapshot(snapshot.project, names, {
      signal, allowInternalWindowsLinks: true,
    }) : [];
    const byPath = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
    if (!same(byPath(entries), byPath(snapshot.entries.map(({ sha256, ...entry }) => entry)))) {
      throw new Error('Rollback project inventory differs from its original snapshot.');
    }
    for (const entry of snapshot.entries.filter(entry => entry.kind === 'file')) {
      if (await fileDigest(path.join(snapshot.project, entry.path), { signal }) !== entry.sha256) {
        throw new Error('Rollback project content differs from its original snapshot.');
      }
    }
    if (snapshot.gitMetadata) {
      const git = await inspectGitMetadata({ project: snapshot.project, commit: snapshot.source.commit, signal });
      if (!same(git.record, gitSourceMetadata(await readSnapshotGit(backup, snapshot)))) {
        throw new Error('Rollback Git source differs from its original snapshot.');
      }
      await git.check();
    }
    const scopes = [{ project: snapshot.project, metadata: snapshot.windowsSecurity, entries },
      ...relocation.parents.map(parent => ({
        project: parent.path, metadata: parent.metadata,
        entries: relocation.entries.filter(entry => path.dirname(entry.path) === parent.path && entry.kind === 'file')
          .map(entry => ({ ...entry, path: path.basename(entry.path) })),
      }))];
    for (const scope of scopes) {
      const security = await inspectWindowsSnapshotSecurity({
        project: scope.project, destinationParent: backup, entries: scope.entries, signal, pwsh,
      });
      const errors = [];
      try {
        if (!windowsRestoredSecurityMatches(scope.metadata, security.metadata, scope.entries)) {
          throw new Error('Rollback security differs from its original snapshot.');
        }
      } catch (error) { errors.push(error); }
      try { await security.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Rollback security verification or cleanup failed.');
    }
    await binding.check({ signal });
  };
  await check();
  return { check };
}
