import { createHash } from 'node:crypto';
import {
  lstat, mkdir, readdir, readlink, statfs, symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual as same } from 'node:util';
import {
  assertSnapshotAbsent, captureSnapshotInventory, fileDigest, inventorySnapshot, readSnapshotJson, realDirectory,
  relativeSnapshotPath, snapshotPathList, writePrivateFile,
} from './snapshot-files.mjs';
export { inventorySnapshot } from './snapshot-files.mjs';
export { rotateSnapshot, reconcileSnapshotSlots } from './snapshot-rotation.mjs';
import { captureExternalSnapshot, validateExternalSnapshot, verifyExternalSnapshot } from './snapshot-external.mjs';
import { syncWorkerDirectory } from './worker-files.mjs';
import { projectSnapshotExclusions } from './snapshot-scope.mjs';
import { captureSnapshotGit, readSnapshotGit, validateSnapshotGit } from './snapshot-git.mjs';
import { prepareGitObjects, readGitObjectSnapshot, validateGitObjects } from './git-objects.mjs';
import { inspectWindowsSnapshotSecurity, validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { prepareWindowsGitSnapshotSecurity } from './windows-git-snapshot-security.mjs';

const projectMetadata = info => ({ mode: info.mode & 0o777, uid: info.uid, gid: info.gid });

export function estimateRequiredBytes({ snapshotBytes, metadataBytes, deploymentBytes }) {
  const values = [snapshotBytes, metadataBytes, deploymentBytes];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0))) {
    throw new Error('Snapshot bytes must be nonnegative safe integers.');
  }
  return values.reduce((sum, value) => sum + value, 0);
}

function validateManifest(manifest) {
  if (![1, 2, 3].includes(manifest?.version) || !/^[a-zA-Z0-9_-]+$/.test(manifest.id ?? '')
    || typeof manifest.project !== 'string' || !path.isAbsolute(manifest.project)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(manifest.source?.commit ?? '')
    || !['observed', 'verified'].includes(manifest.source?.provenance)
    || manifest.runtime?.state !== 'stopped' || !['linux', 'win32'].includes(manifest.runtime?.platform)
    || !Array.isArray(manifest.entries)) throw new Error('Invalid snapshot manifest.');
  if (manifest.version === 1 ? Object.hasOwn(manifest, 'recoveryEngine')
    : (manifest.version === 2 || Object.hasOwn(manifest, 'recoveryEngine'))
      && (typeof manifest.recoveryEngine !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.recoveryEngine))) {
    throw new Error('Invalid snapshot recovery engine binding.');
  }
  if (manifest.version === 3) {
    if (manifest.runtime.platform !== 'win32') throw new Error('Snapshot security metadata requires Windows.');
    validateWindowsSnapshotSecurity(manifest.windowsSecurity, manifest.entries, manifest.project);
  } else if (Object.hasOwn(manifest, 'windowsSecurity')) throw new Error('Unexpected snapshot security metadata.');
  if (manifest.scope !== undefined && !['project', 'selected'].includes(manifest.scope)) {
    throw new Error('Invalid snapshot scope.');
  }
  if (manifest.scope === 'project' && (!same(manifest.excludedPaths, projectSnapshotExclusions)
    || !manifest.projectMetadata)) throw new Error('Incomplete project snapshot scope.');
  if (manifest.projectMetadata !== undefined) {
    const info = manifest.projectMetadata;
    if (!info || !Number.isInteger(info.mode) || info.mode < 0 || info.mode > 0o777
      || !Number.isSafeInteger(info.uid) || info.uid < 0 || !Number.isSafeInteger(info.gid) || info.gid < 0
      || !same(Object.keys(info).sort(), ['gid', 'mode', 'uid'])) {
      throw new Error('Invalid snapshot project metadata.');
    }
  }
  if (Object.hasOwn(manifest, 'windowsExternalSecurity') && manifest.version !== 3) {
    throw new Error('External native security requires a version-3 Windows snapshot.');
  }
  validateExternalSnapshot(manifest.externalFiles ?? [], manifest.project, manifest.windowsExternalSecurity);
  if (manifest.gitMetadata !== undefined) validateSnapshotGit(manifest.gitMetadata);
  if (manifest.gitObjects !== undefined) {
    if (!manifest.gitMetadata) throw new Error('Git objects require matching snapshot metadata.');
    validateGitObjects(manifest.gitObjects);
  }
  const seen = new Map();
  for (const entry of manifest.entries) {
    relativeSnapshotPath(entry.path);
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) throw new Error('Duplicate snapshot manifest path.');
    if (!['directory', 'file', 'link'].includes(entry.kind)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777
      || !Number.isSafeInteger(entry.uid) || entry.uid < 0
      || !Number.isSafeInteger(entry.gid) || entry.gid < 0) throw new Error('Invalid snapshot metadata.');
    if (entry.kind === 'file' && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))) throw new Error('Invalid snapshot checksum metadata.');
    if (entry.kind === 'link' && (typeof entry.target !== 'string' || !entry.target
      || path.isAbsolute(entry.target) || /[\0\r\n]/.test(entry.target))) throw new Error('Invalid snapshot link.');
    seen.set(key, entry);
  }
  const absent = snapshotPathList(manifest.absentPaths ?? []);
  const excluded = snapshotPathList(manifest.excludedPaths ?? []);
  for (const name of absent) {
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if ([...seen].some(([stored, entry]) => stored === key || stored.startsWith(`${key}/`)
      || entry.kind !== 'directory' && key.startsWith(`${stored}/`))) {
      throw new Error('Snapshot absent path conflicts with captured inventory.');
    }
  }
  for (const name of excluded) {
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if ([...seen.keys()].some(stored => stored === key || stored.startsWith(`${key}/`))) {
      throw new Error('Snapshot excluded path conflicts with captured inventory.');
    }
  }
  for (const entry of manifest.entries) {
    const parts = entry.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join('/');
      const key = process.platform === 'win32' ? parent.toLowerCase() : parent;
      if (seen.get(key)?.kind !== 'directory') throw new Error('Missing or unsafe snapshot parent directory.');
    }
  }
  return manifest;
}

export async function createSnapshot(options) {
  const securityScopes = [];
  let failure;
  try {
    return await createSnapshotContents(options, async scope => {
      const security = await inspectWindowsSnapshotSecurity({ ...scope, pwsh: options.pwsh, onProgress: options.onProgress });
      securityScopes.push(security);
      return security;
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors = [];
    for (const security of securityScopes.reverse()) {
      try { await security.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      if (failure) throw new AggregateError([failure, ...errors], 'Snapshot capture and security observation cleanup failed.');
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, 'Snapshot security observation cleanup failed.');
    }
  }
}

async function createSnapshotContents({
  project, destination, id, files, source, runtime, signal, absentPaths = [], excludedPaths = [],
  externalFiles = [], checkSource, projectScope = false, gitMetadata, recoveryEngine, pwsh, onProgress,
}, retainSecurity) {
  signal?.throwIfAborted();
  if (checkSource !== undefined && typeof checkSource !== 'function') throw new Error('Snapshot source check must be callable.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('Snapshot progress reporter must be callable.');
  onProgress?.({ phase: 'snapshot-admission' });
  await checkSource?.();
  let git = gitMetadata === undefined ? null : await captureSnapshotGit(gitMetadata, source?.commit);
  if (runtime?.state !== 'stopped') throw new Error('Snapshot requires a stopped runtime.');
  const root = await realDirectory(project);
  const rootInfo = await lstat(root);
  onProgress?.({ phase: 'snapshot-git-objects-admission' });
  const objects = git ? await prepareGitObjects({ project: root, commit: source.commit, signal, pwsh }) : null;
  if (rootInfo.mode & 0o7000 || typeof projectScope !== 'boolean') throw new Error('Unsupported project snapshot metadata.');
  const checkProject = async () => {
    signal?.throwIfAborted();
    const current = await lstat(await realDirectory(project));
    if (current.dev !== rootInfo.dev || current.ino !== rootInfo.ino
      || !same(projectMetadata(current), projectMetadata(rootInfo))) throw new Error('Snapshot project metadata changed.');
    if (projectScope) {
      const included = (await readdir(root)).sort().filter(name => !projectSnapshotExclusions.includes(name));
      if (!Array.isArray(files) || !same([...files].sort(), included)
        || !same(excludedPaths, projectSnapshotExclusions)) throw new Error('Incomplete project snapshot scope inventory.');
    }
  };
  await checkProject();
  const parent = await realDirectory(path.dirname(destination));
  const target = path.resolve(destination);
  if (target === root || target.startsWith(root + path.sep)) {
    throw new Error('Snapshot destination must be outside the application.');
  }
  onProgress?.({ phase: 'snapshot-external-admission' });
  const external = await captureExternalSnapshot({
    files: externalFiles, project: root, destination: target, signal, retainSecurity,
  });
  absentPaths = snapshotPathList(absentPaths);
  excludedPaths = snapshotPathList(excludedPaths);
  await assertSnapshotAbsent(root, absentPaths);
  onProgress?.({ phase: 'snapshot-project-inventory' });
  const entries = await captureSnapshotInventory(root, files, { signal, excludedPaths, allowInternalWindowsLinks: true });
  onProgress?.({ phase: 'snapshot-source-security', total: entries.length });
  const security = process.platform === 'win32'
    ? await retainSecurity({ project: root, destinationParent: parent, entries, signal }) : null;
  onProgress?.({ phase: 'snapshot-git-security' });
  const gitSecurity = git && security ? await prepareWindowsGitSnapshotSecurity({
    project: root, destinationParent: parent, record: git.record, retainSecurity, signal,
  }) : null;
  if (gitSecurity) git = await captureSnapshotGit(gitMetadata, source.commit, gitSecurity);
  const manifest = {
    version: security ? 3 : recoveryEngine === undefined ? 1 : 2,
    ...(recoveryEngine === undefined ? {} : { recoveryEngine }),
    ...(security ? { windowsSecurity: security.metadata } : {}),
    ...(external.windowsSecurity ? { windowsExternalSecurity: external.windowsSecurity } : {}),
    id, project: root, createdAt: new Date().toISOString(), source, runtime, absentPaths, excludedPaths,
    scope: projectScope ? 'project' : 'selected', projectMetadata: projectMetadata(rootInfo),
    externalFiles: external.entries,
    ...(git ? { gitMetadata: git.descriptor } : {}),
    ...(objects ? { gitObjects: { version: 1, bytes: objects.bytes, sha256: '0'.repeat(64) } } : {}),
    entries: entries.map(entry => entry.kind === 'file' ? { ...entry, sha256: '0'.repeat(64) } : entry),
  };
  validateManifest(manifest);
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  if (manifestBytes > 32 * 1024 * 1024) throw new Error('Snapshot manifest exceeds size limit.');
  const snapshotBytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0),
    external.bytes + (git?.bytes.length ?? 0) + (objects?.bytes ?? 0));
  const required = estimateRequiredBytes({
    snapshotBytes, metadataBytes: manifestBytes + 64 * 1024 + (objects ? 32 * 1024 * 1024 : 0), deploymentBytes: 0,
  });
  const space = await statfs(parent, { bigint: true });
  if (space.bavail * space.bsize < BigInt(required)) throw new Error('Insufficient space for snapshot bytes.');
  signal?.throwIfAborted();
  await mkdir(target, { mode: 0o700 });
  await writePrivateFile(path.join(target, 'owner.json'), JSON.stringify({ version: 1, project: root, id }));
  if (git) await writePrivateFile(path.join(target, 'git.json'), git.bytes);
  onProgress?.({ phase: 'snapshot-copy-git' });
  if (objects) manifest.gitObjects = await objects.copy(path.join(target, 'git-objects'));
  const contents = path.join(target, 'files');
  await mkdir(contents, { mode: 0o700 });
  const ordered = [...manifest.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const entry of ordered.filter(item => item.kind === 'directory')) {
    signal?.throwIfAborted();
    await mkdir(path.join(contents, entry.path), { mode: 0o700 });
  }
  const copiedFiles = ordered.filter(item => item.kind === 'file');
  let copied = 0;
  onProgress?.({ phase: 'snapshot-copy-files', completed: copied, total: copiedFiles.length });
  for (const entry of copiedFiles) {
    signal?.throwIfAborted();
    const from = path.join(root, entry.path);
    const to = path.join(contents, entry.path);
    await realDirectory(path.dirname(from));
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
      throw new Error('Snapshot source changed during copying.');
    }
    signal?.throwIfAborted();
    await pipeline(
      createReadStream(from, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }),
      createWriteStream(to, { flags: 'wx', mode: 0o600, flush: true }), { signal },
    );
    entry.sha256 = await fileDigest(to, { signal });
    if (entry.sha256 !== await fileDigest(from, { signal })) throw new Error('Snapshot source checksum changed during copying.');
    copied++;
    if (copied === copiedFiles.length || copied % Math.max(1, Math.ceil(copiedFiles.length / 4)) === 0) {
      onProgress?.({ phase: 'snapshot-copy-files', completed: copied, total: copiedFiles.length });
    }
  }
  for (const entry of ordered.filter(item => item.kind === 'link')) {
    signal?.throwIfAborted();
    if (process.platform === 'win32') {
      if (security?.metadata.version !== 2) throw new Error('Windows snapshot links require native ACL/reparse metadata.');
      continue;
    }
    await symlink(entry.target, path.join(contents, entry.path));
  }
  onProgress?.({ phase: 'snapshot-copy-external' });
  await external.copy();
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('Snapshot manifest exceeds size limit.');
  await assertSnapshotAbsent(root, absentPaths);
  await external.check();
  signal?.throwIfAborted();
  await writePrivateFile(path.join(target, 'manifest.json'), serialized);
  signal?.throwIfAborted();
  await checkSource?.();
  if (git) await gitMetadata.check();
  await gitSecurity?.check();
  await objects?.check();
  await checkProject();
  await assertSnapshotAbsent(root, absentPaths);
  onProgress?.({ phase: 'snapshot-verify-source-inventory' });
  if (!same(entries, await captureSnapshotInventory(root, files, { signal, excludedPaths, allowInternalWindowsLinks: true }))) {
    throw new Error('Snapshot source inventory or metadata changed during capture.');
  }
  onProgress?.({ phase: 'snapshot-verify-source-checksums' });
  for (const entry of manifest.entries.filter(item => item.kind === 'file')) {
    if (entry.sha256 !== await fileDigest(path.join(root, entry.path), { signal })) {
      throw new Error('Snapshot source checksum changed before completion.');
    }
  }
  await external.check();
  await security?.check({ signal });
  onProgress?.({ phase: 'snapshot-verify-backup' });
  await verifySnapshotContents(target, manifest, { signal, complete: false });
  const manifestDigest = createHash('sha256').update(serialized).digest('hex');
  if (manifestDigest !== await fileDigest(path.join(target, 'manifest.json'), { signal })) {
    throw new Error('Snapshot manifest integrity failure before completion.');
  }
  onProgress?.({ phase: 'snapshot-sync' });
  for (const entry of ordered.filter(item => item.kind === 'directory').reverse()) {
    signal?.throwIfAborted();
    await syncWorkerDirectory(path.join(contents, entry.path));
  }
  await syncWorkerDirectory(contents);
  if (external.entries.length) await syncWorkerDirectory(path.join(target, 'external'));
  await syncWorkerDirectory(target);
  if (git) await gitMetadata.check();
  await gitSecurity?.check();
  await objects?.check();
  await security?.check({ signal });
  signal?.throwIfAborted();
  await writePrivateFile(path.join(target, 'complete.json'), JSON.stringify({
    version: 1, id, sha256: manifestDigest,
  }));
  await syncWorkerDirectory(target);
  await syncWorkerDirectory(parent);
  onProgress?.({ phase: 'snapshot-verify-completed' });
  return verifySnapshot(target, { signal });
}

export async function verifySnapshot(destination, { signal } = {}) {
  signal?.throwIfAborted();
  const root = await realDirectory(destination);
  let completion;
  try { completion = await readSnapshotJson(path.join(root, 'complete.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Incomplete snapshot: completion marker missing.', { cause: error });
    throw error;
  }
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = validateManifest(await readSnapshotJson(manifestFile));
  if (completion.version !== 1 || completion.id !== manifest.id
    || completion.sha256 !== await fileDigest(manifestFile, { signal })) throw new Error('Snapshot manifest integrity failure.');
  await verifySnapshotContents(root, manifest, { signal });
  return manifest;
}

async function verifySnapshotContents(root, manifest, { signal, complete = true }) {
  const owner = await readSnapshotJson(path.join(root, 'owner.json'));
  if (owner.version !== 1 || owner.id !== manifest.id || owner.project !== manifest.project) {
    throw new Error('Snapshot owner does not match manifest.');
  }
  const topLevel = (await readdir(root)).sort();
  const expectedTopLevel = [...(complete ? ['complete.json'] : []), 'files', 'manifest.json', 'owner.json',
    ...(manifest.externalFiles?.length ? ['external'] : []), ...(manifest.gitMetadata ? ['git.json'] : []),
    ...(manifest.gitObjects ? ['git-objects'] : [])].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) {
    throw new Error('Unexpected snapshot files; inspection required.');
  }
  await verifyExternalSnapshot(root, manifest.externalFiles ?? [], signal);
  if (manifest.gitMetadata) await readSnapshotGit(root, manifest);
  if (manifest.gitObjects) await readGitObjectSnapshot(root, manifest, { signal });
  const contents = await realDirectory(path.join(root, 'files'));
  await assertSnapshotAbsent(contents, manifest.absentPaths ?? []);
  const observed = await inventorySnapshot(contents, await readdir(contents), { signal });
  const byPath = new Map(observed.map(entry => [entry.path, entry]));
  const nativeLinks = manifest.version === 3 && manifest.windowsSecurity.version === 2;
  const physicalEntries = manifest.entries.filter(entry => !nativeLinks || entry.kind !== 'link');
  if (byPath.size !== physicalEntries.length) throw new Error('Snapshot inventory integrity failure.');
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    const actual = byPath.get(entry.path);
    if (nativeLinks && entry.kind === 'link') {
      if (actual) throw new Error('Native snapshot junction must be metadata only.');
      continue;
    }
    if (!actual || actual.kind !== entry.kind) throw new Error('Snapshot file type integrity failure.');
    const file = path.join(contents, entry.path);
    if (entry.kind === 'file' && (actual.bytes !== entry.bytes || await fileDigest(file, { signal }) !== entry.sha256)) {
      throw new Error(`Snapshot file size or checksum integrity failure: ${entry.path}`);
    }
    if (entry.kind === 'link' && await readlink(file) !== entry.target) throw new Error('Snapshot link integrity failure.');
  }
}
