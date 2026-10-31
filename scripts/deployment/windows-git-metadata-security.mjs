import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureWorkerFields } from './worker-identity.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { windowsGitMetadataInventory } from './windows-git-snapshot-security.mjs';
import { openWindowsSourceSecurityController } from './windows-source-security-controller.mjs';
import { inspectWindowsSnapshotSecurity } from './windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from './windows-restore-security.mjs';

const script = fileURLToPath(new URL('./windows-git-metadata-security.ps1', import.meta.url));
const refused = cause => new Error('Windows Git metadata security restoration refused.', { cause });
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function validateWindowsGitPolicy(value, kind) {
  const policy = captureWorkerFields(value, ['securityDescriptor', 'attributes'], 'Git native policy');
  if (typeof policy.securityDescriptor !== 'string' || !policy.securityDescriptor
    || Buffer.byteLength(policy.securityDescriptor) > 8192 || /[\0\r\n]/.test(policy.securityDescriptor)
    || !Number.isInteger(policy.attributes) || policy.attributes < 1 || policy.attributes > 8375
    || (policy.attributes & ~8375) || Boolean(policy.attributes & 16) !== (kind === 'directory')
    || (policy.attributes & 128) && policy.attributes !== 128) throw new Error('Invalid Git native policy.');
  return Object.freeze(policy);
}

export async function prepareWindowsGitMetadataSecurity({ project, backup, record, signal, pwsh = 'pwsh.exe' }) {
  if (process.platform !== 'win32' || record.version !== 2 || ![project, backup].every(value =>
    typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
    || inside(project, backup) || inside(backup, project)) {
    throw new Error('Windows Git metadata restoration requires disjoint canonical source and private backup roots.');
  }
  await canonicalWorkerDirectory(project);
  await canonicalWorkerDirectory(backup);
  const directory = (await canonicalWorkerDirectory(path.join(project, '.git'))).root;
  const inventory = windowsGitMetadataInventory(record.ref);
  const present = inventory.filter(entry => !record.absentPaths.includes(entry.path));
  const metadata = record.windowsSecurity;
  const policies = new Map(metadata.entries.map(entry => [entry.path, {
    securityDescriptor: metadata.descriptors[entry.security], attributes: entry.attributes,
  }]));
  const sizes = new Map([['HEAD', Buffer.from(record.head, 'base64').length],
    ['index', Buffer.from(record.index, 'base64').length],
    ...(record.ref ? [[record.ref, Buffer.byteLength(`${record.commit}\n`)]] : [])]);
  const savedEntries = inventory.map(entry => ({
    ...entry, bytes: sizes.get(entry.path) ?? 0, inherit: !policies.has(entry.path),
    securityDescriptor: policies.get(entry.path)?.securityDescriptor ?? null,
    attributes: policies.get(entry.path)?.attributes ?? null,
  }));
  const currentEntries = [...inventory, { path: 'config', kind: 'file' }, { path: 'packed-refs', kind: 'file' },
    ...inventory.filter(entry => entry.kind === 'file').map(entry => ({ ...entry, path: `${entry.path}.lock` })),
    { path: 'agents-chat-restore', kind: 'directory' }, { path: 'agents-chat-restore/intent.json', kind: 'file' }];
  const kinds = new Map(currentEntries.map(entry => [entry.path, entry.kind]));
  kinds.set('', 'directory');
  const relative = file => {
    const name = path.relative(directory, file).split(path.sep).join('/');
    if (!kinds.has(name) || path.resolve(directory, name) !== file) throw new Error('Git native path is outside its inventory.');
    return name;
  };
  const { invoke } = await openWindowsSourceSecurityController({
    project: directory, backup, metadata, savedEntries, currentEntries, signal, pwsh, script, refused,
    decodeReply: (method, value) => {
      if (method !== 'capture') {
        if (value !== method) throw new Error('Unexpected Git security acknowledgement.');
        return;
      }
      if (value === null) return null;
      const result = captureWorkerFields(value, ['path', 'dev', 'ino', 'bytes', 'windowsSecurity'], 'Git native observation');
      if (!kinds.has(result.path) || ![result.dev, result.ino].every(value => typeof value === 'string'
        && /^(0|[1-9][0-9]{0,19})$/.test(value)) || !Number.isSafeInteger(result.bytes) || result.bytes < 0) {
        throw new Error('Invalid Git native observation.');
      }
      return { ...result, windowsSecurity: validateWindowsGitPolicy(result.windowsSecurity, kinds.get(result.path)) };
    },
  });
  const capture = async file => {
    const name = relative(file);
    const value = await invoke('capture', [{ path: name }]);
    if (value && value.path !== name) throw new Error('Git native observation path differs.');
    return value;
  };
  const command = (method, file) => invoke(method, [{ path: relative(file) }]);
  return Object.freeze({
    check: () => invoke('check'),
    observeFile: async (file, value) => {
      const native = await capture(file);
      if (value === null && native === null) return null;
      if (!value || !native || value.dev !== native.dev || value.ino !== native.ino || value.bytes !== native.bytes) {
        throw new Error('Git native file observation differs from captured bytes.');
      }
      return { ...value, windowsSecurity: native.windowsSecurity };
    },
    observeDirectory: async (file, value) => {
      const native = await capture(file);
      if (!native || value.dev !== native.dev || value.ino !== native.ino || native.bytes !== 0) {
        throw new Error('Git native directory identity differs.');
      }
      return { ...value, windowsSecurity: native.windowsSecurity };
    },
    prepareParents: async () => {
      for (const entry of inventory.filter(entry => entry.kind === 'directory')) {
        await invoke('directory', [{ path: entry.path }]);
      }
    },
    createGuard: () => invoke('guard'),
    createStage: file => command('create-stage', file),
    finishStage: file => command('finish-stage', file),
    assertIntentBudget: value => {
      const budget = Buffer.byteLength(JSON.stringify(value)) + (sizes.size + 3) * 8192;
      if (budget > 65536) throw new Error('Windows Git restore intent exceeds its supported private evidence budget.');
    },
    writeProof: bytes => invoke('write-proof', [{ text: bytes.toString('utf8') }]),
    retainProof: proof => invoke('proof', [proof]),
    publish: (file, entry) => invoke('publish', [{ path: relative(file), before: entry.before, staged: entry.staged }]),
    retire: () => invoke('retire'),
    verify: async () => {
      await invoke('complete');
      const observed = await inspectWindowsSnapshotSecurity({ project: directory, destinationParent: backup, entries: present, signal, pwsh });
      const errors = [];
      if (!windowsRestoredSecurityMatches(metadata, observed.metadata, present)) {
        errors.push(new Error('Restored Git metadata permissions differ from saved security.'));
      }
      try { await observed.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Git metadata security verification failed.');
    },
    close: () => invoke('close'),
  });
}
