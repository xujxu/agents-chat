import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from './snapshot-files.mjs';
import { openWindowsSourceSecurityController } from './windows-source-security-controller.mjs';
import { inspectWindowsSnapshotSecurity, validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from './windows-restore-security.mjs';

const script = fileURLToPath(new URL('./windows-git-object-security.ps1', import.meta.url));
const refused = cause => new Error('Windows Git object security restoration refused.', { cause });
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function prepareWindowsGitObjectSecurity({
  project, backup, manifest, current, signal, pwsh = 'pwsh.exe',
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || manifest.version !== 3 || manifest.runtime.platform !== 'win32'
    || manifest.project !== project || ![project, backup].every(value => typeof value === 'string'
      && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
    || inside(project, backup) || inside(backup, project) || !Array.isArray(current) || current.length > 250000) {
    throw new Error('Windows Git object restoration requires native ACL metadata and disjoint original roots.');
  }
  const metadata = validateWindowsSnapshotSecurity(manifest.windowsSecurity, manifest.entries);
  const savedEntries = manifest.entries.map((entry, index) => ({
    path: entry.path, kind: entry.kind, bytes: entry.bytes ?? 0,
    securityDescriptor: metadata.descriptors[metadata.entries[index].security],
    attributes: metadata.entries[index].attributes,
  }));
  const savedNames = new Set(savedEntries.map(entry => entry.path));
  const preserved = current.filter(entry => !savedNames.has(entry.path) && !entry.path.endsWith('.agents-chat-restore'));
  try {
    const info = await lstat(path.join(project, 'info/packs'));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Excluded Git pack listing is not an ordinary file.');
    preserved.push({ path: 'info/packs', kind: 'file' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const witnesses = [];
  for (const entry of preserved.filter(entry => entry.kind === 'file')) {
    const file = path.join(project, entry.path);
    const info = await lstat(file, { bigint: true });
    witnesses.push({ file, dev: info.dev, ino: info.ino, sha256: await fileDigest(file, { signal }) });
  }
  const { invoke } = await openWindowsSourceSecurityController({
    project, backup, metadata, savedEntries,
    currentEntries: current.map(({ path, kind }) => ({ path, kind })), signal, pwsh, script, refused,
  });
  let unchanged;
  const close = async () => {
    const errors = [];
    try { await unchanged?.close(); } catch (error) { errors.push(error); }
    try { await invoke('close'); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Windows Git security cleanup failed.');
  };
  try {
    unchanged = await inspectWindowsSnapshotSecurity({
      project, destinationParent: backup, entries: preserved, signal, pwsh,
    });
    const entryCommand = method => ({ entry, signal }) => invoke(method, [{ path: entry.path }], signal);
    return Object.freeze({
      check: ({ signal } = {}) => invoke('check', undefined, signal),
      directory: entryCommand('directory'),
      createStage: entryCommand('create-stage'),
      finishStage: entryCommand('finish-stage'),
      stagePolicy: entryCommand('stage-policy'),
      removeStage: entryCommand('remove-stage'),
      targetPolicy: entryCommand('target-policy'),
      verify: async ({ signal: verifySignal = signal } = {}) => {
        await invoke('complete', [], verifySignal);
        await unchanged.check({ signal: verifySignal });
        for (const witness of witnesses) {
          const info = await lstat(witness.file, { bigint: true });
          if (!info.isFile() || info.isSymbolicLink() || info.dev !== witness.dev || info.ino !== witness.ino
            || await fileDigest(witness.file, { signal: verifySignal }) !== witness.sha256) {
            throw new Error('Preserved Git object or excluded pack listing changed.');
          }
        }
        const observed = await inspectWindowsSnapshotSecurity({
          project, destinationParent: backup, entries: manifest.entries, signal: verifySignal, pwsh,
        });
        const errors = [];
        if (!windowsRestoredSecurityMatches(metadata, observed.metadata, manifest.entries)) {
          errors.push(new Error('Restored Git object ACL or attributes differ from the snapshot.'));
        }
        try { await observed.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Windows Git object policy verification failed.');
      },
      close,
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows Git security admission and cleanup failed.'); }
    throw error;
  }
}
