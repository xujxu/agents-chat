import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { inspectWindowsSnapshotSecurity, validateWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';

const script = fileURLToPath(new URL('./windows-restore-security.ps1', import.meta.url));
const refused = cause => new Error('Windows project security restoration refused.', { cause });
const redactedPolicy = value => String(value).replace(/S-1-[0-9-]+/g,
  sid => `<sid:${createHash('sha256').update(sid).digest('hex').slice(0, 12)}>`);

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
  const metadata = validateWindowsSnapshotSecurity(manifest.windowsSecurity, manifest.entries);
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
  const savedEntries = inventory(manifest.entries).map((entry, index) => ({
    ...entry, securityDescriptor: metadata.descriptors[metadata.entries[index].security],
    attributes: metadata.entries[index].attributes, bytes: manifest.entries[index].bytes ?? 0,
  }));
  const currentEntries = inventory(current);
  if (![project, backup].every(value => typeof value === 'string' && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) throw new Error('Invalid Windows restoration roots.');
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original project restore controller is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native project security restoration',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Project', project, '-Backup', backup,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'project', 'backup', 'root'], 'restore security readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid) || ready.project !== project || ready.backup !== backup) {
      throw new Error('Original project restore controller differs.');
    }
    const root = captureWorkerFields(ready.root, ['securityDescriptor', 'attributes'], 'restore root security');
    if (root.securityDescriptor !== metadata.descriptors[metadata.root.security] || root.attributes !== metadata.root.attributes) {
      const error = new Error('Original project root security policy or attributes differ from the snapshot.');
      error.comparison = {
        expectedAttributes: metadata.root.attributes, observedAttributes: root.attributes,
        expectedPolicy: redactedPolicy(metadata.descriptors[metadata.root.security]),
        observedPolicy: redactedPolicy(root.securityDescriptor),
      };
      throw error;
    }
    const request = async (method, entries, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new Error('Project security controller is closed.');
      const id = ++sequence;
      await wire.send({ id, method, entries });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 60000 }),
        ['id', 'type', 'processIdentity', 'value'], 'restore security acknowledgement');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity || reply.value !== method) {
        throw new Error('Unexpected project security acknowledgement.');
      }
    };
    const batch = async (method, entries) => {
      for (let offset = 0; offset < entries.length;) {
        const items = [];
        let bytes = 0;
        while (offset < entries.length && items.length < 8) {
          const size = Buffer.byteLength(JSON.stringify(entries[offset]));
          if (items.length && bytes + size > 110000) break;
          items.push(entries[offset++]);
          bytes += size;
        }
        await request(method, items, signal);
      }
    };
    await batch('admit-saved', savedEntries);
    await batch('admit-current', currentEntries);
    await request('seal', [], signal);
    const invoke = async (method, entries = [], requestSignal = signal) => {
      if (busy) throw refused(new Error('Project security restoration is active.'));
      if (closed) {
        if (method === 'close') return;
        throw refused(new Error('Project security restoration is closed.'));
      }
      busy = true;
      try {
        await request(method, entries, method === 'close' ? undefined : requestSignal);
        if (method === 'close') {
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Project security controller close failed.');
          closed = true;
          wire.close();
        }
      } catch (cause) {
        closed = true;
        throw await abandon(cause);
      } finally { busy = false; }
    };
    const applyEntries = async (method, entries, requestSignal) => {
      for (let offset = 0; offset < entries.length; offset += 8) {
        await invoke(method, entries.slice(offset, offset + 8).map(({ path }) => ({ path })), requestSignal);
      }
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
      restore: async ({ signal: restoreSignal = signal } = {}) => {
        const ordered = [...savedEntries].sort((a, b) =>
          Number(a.kind === 'file') - Number(b.kind === 'file') || a.path.split('/').length - b.path.split('/').length);
        await applyEntries('restore', ordered, restoreSignal);
        await invoke('finish-restore', [], restoreSignal);
        const observed = await inspectWindowsSnapshotSecurity({
          project, destinationParent: backup, entries: manifest.entries, signal: restoreSignal, pwsh,
        });
        const errors = [];
        if (!windowsRestoredSecurityMatches(metadata, observed.metadata, manifest.entries)) {
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
      },
      close: () => invoke('close'),
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
