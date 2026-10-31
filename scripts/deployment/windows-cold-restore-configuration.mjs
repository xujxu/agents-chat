import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectWindowsRuntimeConfiguration } from './windows-configuration.mjs';
import { inspectWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from './windows-restore-security.mjs';

export async function inspectWindowsColdConfiguration({
  project, backup, runtimeBundle, snapshot, providers, profile, pwsh, signal, recheck,
}) {
  signal?.throwIfAborted();
  let configuration;
  let security;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([configuration?.close(), security?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Cold configuration resource cleanup failed.');
  };
  try {
    configuration = await inspectWindowsRuntimeConfiguration({
      project, configuration: runtimeBundle.configuration, sha256: runtimeBundle.sha256,
      pwsh, profile, signal, recheck,
    });
    if (!same(configuration.providers, providers)) throw new Error('Restored configuration differs from admitted providers.');
    const selected = new Set();
    for (const file of configuration.files) {
      const name = path.relative(project, file.path).split(path.sep).join('/');
      const entry = snapshot.entries.find(entry => entry.path === name);
      if (file.present !== Boolean(entry) || entry
        && (entry.kind !== 'file' || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes)) {
        throw new Error('Restored configuration differs from the original snapshot.');
      }
      if (entry) selected.add(name);
    }
    const entries = snapshot.entries.filter(entry => selected.has(entry.path));
    const metadata = snapshot.windowsSecurity;
    const records = metadata.entries.filter(entry => selected.has(entry.path));
    const descriptors = [...new Set([metadata.root, ...records].map(entry => metadata.descriptors[entry.security]))];
    const remap = entry => ({ ...entry, security: descriptors.indexOf(metadata.descriptors[entry.security]) });
    const expected = { version: 1, descriptors, root: remap(metadata.root), entries: records.map(remap) };
    security = await inspectWindowsSnapshotSecurity({ project, destinationParent: backup, entries, pwsh, signal });
    if (!windowsRestoredSecurityMatches(expected, security.metadata, entries)) {
      throw new Error('Restored configuration security differs from the original snapshot.');
    }
    const checkFiles = async ({ signal: checkSignal = signal } = {}) => {
      checkSignal?.throwIfAborted();
      if (closed) throw new Error('Cold restored configuration is closed.');
      await configuration.checkFiles({ signal: checkSignal });
      await security.check({ signal: checkSignal });
      await configuration.checkFiles({ signal: checkSignal });
    };
    await recheck();
    await checkFiles({ signal });
    return Object.freeze({ ...configuration, checkFiles, close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold configuration inspection and close failed.'); }
    throw error;
  }
}
