import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';
import { validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino });
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function inspectWindowsRuntimeRelocation({ project, backup, snapshot, runtimeBundle, signal }) {
  signal?.throwIfAborted();
  const bundle = captureWorkerFields(runtimeBundle, ['directory', 'configuration', 'sha256'], 'restored runtime bundle');
  const { root } = await canonicalWorkerDirectory(bundle.directory, { privateMode: true });
  if (root !== bundle.directory || bundle.configuration !== path.join(root, 'configuration.json')
    || inside(project, root) || inside(root, project) || inside(backup, root) || inside(root, backup)
    || (snapshot.externalFiles ?? []).some(entry => inside(root, entry.path))) {
    throw new Error('Runtime relocation requires a distinct private external bundle outside the project and backup.');
  }
  const original = identity(await lstat(root, { bigint: true }));
  const archived = await inspectWindowsSnapshotRuntime({
    project, backup, snapshot, taskName: snapshot.runtime.task?.name, signal,
  });
  if (bundle.sha256 !== archived.task.configurationSha256
    || root === path.dirname(archived.task.configuration)) {
    throw new Error('Runtime relocation differs from the archived configuration.');
  }
  const verifyFiles = async () => {
    signal?.throwIfAborted();
    if (!same((await readdir(root)).sort(), archived.files.map(file => file.name).sort())) {
      throw new Error('Runtime relocation requires exactly the archived configuration and helpers, without stale runtime evidence.');
    }
    for (const file of archived.files) {
      signal?.throwIfAborted();
      if (!(await readWorkerFile(path.join(root, file.name), 1024 * 1024, { privateMode: true }))
        .equals(await readWorkerFile(file.file, 1024 * 1024, { privateMode: true }))) {
        throw new Error('Relocated runtime member differs from the authoritative archive.');
      }
    }
  };
  await verifyFiles();
  const destinations = new Map(archived.files.map(file =>
    [path.join(path.dirname(archived.task.configuration), file.name), path.join(root, file.name)]));
  const groups = new Map();
  const parents = new Map((snapshot.windowsExternalSecurity?.parents ?? []).map(parent => [parent.path, parent]));
  const entries = (snapshot.externalFiles ?? []).map(entry => {
    const target = destinations.get(entry.path) ?? entry.path;
    const parent = parents.get(path.dirname(entry.path));
    if (!parent || parent.metadata.version !== 1) throw new Error('Unsupported runtime relocation parent security.');
    const destinationParent = path.dirname(target);
    let group = groups.get(destinationParent);
    if (!group) {
      group = { path: destinationParent, parent, entries: [] };
      groups.set(destinationParent, group);
    }
    if (group.parent !== parent || group.entries.some(value => value.path.toLowerCase() === path.basename(target).toLowerCase())) {
      throw new Error('Runtime relocation destination or parent policy collides.');
    }
    if (entry.kind === 'file') {
      const metadata = parent.metadata.entries.find(value => value.path === path.basename(entry.path));
      if (!metadata) throw new Error('Runtime relocation member security is absent.');
      group.entries.push({ ...metadata, path: path.basename(target) });
    }
    return Object.freeze({ ...entry, path: target });
  });
  const projectedParents = [...groups.values()].map(group => {
    const descriptors = [];
    const remap = entry => {
      const descriptor = group.parent.metadata.descriptors[entry.security];
      let index = descriptors.indexOf(descriptor);
      if (index === -1) { index = descriptors.length; descriptors.push(descriptor); }
      return { ...entry, security: index };
    };
    const metadata = { version: 1, descriptors, root: remap(group.parent.metadata.root), entries: group.entries.map(remap) };
    const inventory = entries.filter(entry => path.dirname(entry.path) === group.path && entry.kind === 'file')
      .map(entry => ({ ...entry, path: path.basename(entry.path) }));
    return Object.freeze({ path: group.path, metadata: validateWindowsSnapshotSecurity(metadata, inventory) });
  });
  const check = async () => {
    signal?.throwIfAborted();
    if ((await canonicalWorkerDirectory(root, { privateMode: true })).root !== root
      || !same(identity(await lstat(root, { bigint: true })), original)) {
      throw new Error('Original relocated runtime directory changed.');
    }
  };
  await archived.check({ signal });
  await check();
  return Object.freeze({
    entries: Object.freeze(entries), parents: Object.freeze(projectedParents), check,
    async verify() { await check(); await archived.check({ signal }); await verifyFiles(); await check(); },
  });
}
