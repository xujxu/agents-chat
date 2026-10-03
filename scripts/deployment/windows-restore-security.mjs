import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWindowsSourceSecurityController, redactedWindowsPolicy as redactedPolicy } from './windows-source-security-controller.mjs';
import { inspectWindowsSnapshotSecurity, validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';

const script = fileURLToPath(new URL('./windows-restore-security.ps1', import.meta.url));
const refused = cause => new Error('Windows project security restoration refused.', { cause });

// SetSecurityInfo can mark a legacy DACL auto-inherited without changing its ACEs.
const restoredPolicyMatches = (expected, observed) => observed === expected
  || observed.replace(/D:([A-Z]*)(?=\(|$)/, (_, flags) => `D:${flags.replace(/AI/g, '')}`) === expected;

export function windowsRestoredSecurityMatches(expected, observed, inventory) {
  const saved = validateWindowsSnapshotSecurity(expected, inventory);
  const actual = validateWindowsSnapshotSecurity(observed, inventory);
  if (saved.root.attributes !== actual.root.attributes
    || saved.descriptors[saved.root.security] !== actual.descriptors[actual.root.security]) return false;
  return saved.entries.every((entry, index) => entry.attributes === actual.entries[index].attributes
    && restoredPolicyMatches(saved.descriptors[entry.security], actual.descriptors[actual.entries[index].security]));
}

export async function prepareWindowsProjectRestoreSecurity({
  project, backup, manifest, current, signal, pwsh = 'pwsh.exe',
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || manifest.version !== 3 || manifest.runtime.platform !== 'win32') {
    throw new Error('Windows project restoration requires a snapshot with native ACL metadata.');
  }
  if (manifest.gitMetadata || manifest.gitObjects || manifest.externalFiles?.length) {
    throw new Error('Windows Git and external restoration require their native security adapters.');
  }
  return prepareWindowsSourceRestoreSecurity({
    project, backup, entries: manifest.entries, metadata: manifest.windowsSecurity, current, signal, pwsh,
  });
}

export async function prepareWindowsSourceRestoreSecurity({
  project, backup, entries, metadata: supplied, current, signal, pwsh = 'pwsh.exe',
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') throw new Error('Native source security restoration requires Windows.');
  const metadata = validateWindowsSnapshotSecurity(supplied, entries);
  const inventory = entries => {
    if (!Array.isArray(entries) || entries.length > 250000) throw new Error('Unsupported Windows restore inventory.');
    const paths = new Set();
    return entries.map(entry => {
      if (typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096
        || /[\\:\0\r\n<>"|*?]/.test(entry.path)
        || entry.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
          || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3])(\.|$)/i.test(part))
        || ['.git', 'logs', '.npm', '.pnpm-store'].includes(entry.path.split('/')[0].toLowerCase())
        || !['file', 'directory'].includes(entry.kind) || paths.has(entry.path.toLowerCase())) {
        throw new Error('Unsupported or aliased Windows restoration path.');
      }
      paths.add(entry.path.toLowerCase());
      return { path: entry.path, kind: entry.kind };
    });
  };
  const savedEntries = inventory(entries).map((entry, index) => ({
    ...entry, securityDescriptor: metadata.descriptors[metadata.entries[index].security],
    attributes: metadata.entries[index].attributes, bytes: entries[index].bytes ?? 0,
  }));
  const currentEntries = inventory(current);
  if (![project, backup].every(value => typeof value === 'string' && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) throw new Error('Invalid Windows restoration roots.');
  const { invoke, applyEntries } = await openWindowsSourceSecurityController({
    project, backup, metadata, savedEntries, currentEntries, signal, pwsh, script, refused,
  });
  const verify = async ({ signal: restoreSignal = signal } = {}) => {
    await invoke('check', [], restoreSignal);
    const observed = await inspectWindowsSnapshotSecurity({
      project, destinationParent: backup, entries, signal: restoreSignal, pwsh,
    });
    const errors = [];
    if (!windowsRestoredSecurityMatches(metadata, observed.metadata, entries)) {
      const error = new Error('Restored Windows ACL or attributes differ from the snapshot.');
      for (let index = -1; index < metadata.entries.length; index++) {
        const expected = index < 0 ? metadata.root : metadata.entries[index];
        const actual = index < 0 ? observed.metadata.root : observed.metadata.entries[index];
        const expectedPolicy = metadata.descriptors[expected.security];
        const actualPolicy = observed.metadata.descriptors[actual.security];
        if (expected.attributes !== actual.attributes
          || (index < 0 ? expectedPolicy !== actualPolicy : !restoredPolicyMatches(expectedPolicy, actualPolicy))) {
          error.comparison = {
            path: index < 0 ? '.' : expected.path,
            expectedAttributes: expected.attributes, observedAttributes: actual.attributes,
            expectedPolicy: redactedPolicy(expectedPolicy), observedPolicy: redactedPolicy(actualPolicy),
          };
          break;
        }
      }
      error.message += error.comparison ? ` ${JSON.stringify(error.comparison)}`
        : ' Descriptor table indexing differs despite matching entry policies.';
      errors.push(error);
    }
    try { await observed.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Windows restored security verification failed.');
  };
  return Object.freeze({
    checkRoot: ({ signal } = {}) => invoke('check', undefined, signal),
    prepareRemoval: async ({ signal } = {}) => {
      const directories = currentEntries.filter(entry => entry.kind === 'directory')
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
      await applyEntries('prepare', directories, signal);
      await invoke('begin-removal', [], signal);
    },
    remove: ({ entry, signal }) => invoke('remove', [{ path: entry.path }], signal),
    createDirectory: ({ entry, signal }) => invoke('mkdir', [{ path: entry.path }], signal),
    createFile: ({ entry, signal }) => invoke('create', [{ path: entry.path }], signal),
    finishFile: ({ entry, signal }) => invoke('finish', [{ path: entry.path }], signal),
    verify,
    restore: async ({ signal: restoreSignal = signal } = {}) => {
      const ordered = [...savedEntries].sort((a, b) =>
        Number(a.kind === 'file') - Number(b.kind === 'file') || a.path.split('/').length - b.path.split('/').length);
      await applyEntries('restore', ordered, restoreSignal);
      await invoke('finish-restore', [], restoreSignal);
      await verify({ signal: restoreSignal });
    },
    close: () => invoke('close'),
  });
}
