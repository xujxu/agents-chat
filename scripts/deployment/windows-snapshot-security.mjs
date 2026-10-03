import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-snapshot-security.ps1', import.meta.url));
const supportedAttributes = 1 | 2 | 4 | 16 | 32 | 128 | 8192;
const descriptor = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= 8192 && !/[\0\r\n]/.test(value);
const attributes = (value, kind) => Number.isInteger(value) && value > 0 && value <= (supportedAttributes | 1024)
  && !(value & ~(supportedAttributes | (kind === 'link' ? 1024 : 0)))
  && Boolean(value & 16) === (kind !== 'file') && Boolean(value & 1024) === (kind === 'link')
  && (!(value & 128) || value === 128);
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const refused = cause => new Error('Windows snapshot source security observation refused.', { cause });

function directoryLinkTarget(project, name, data, kind) {
  if (typeof data !== 'string' || !data.length || data.length > 21848) throw new Error('Invalid junction reparse data.');
  const bytes = Buffer.from(data, 'base64');
  const symbolic = kind === 'directory-symlink';
  const start = symbolic ? 20 : 16;
  if (bytes.toString('base64') !== data || bytes.length < start || bytes.length > 16384
    || bytes.readUInt32LE(0) !== (symbolic ? 0xa000000c : 0xa0000003) || bytes.readUInt16LE(4) + 8 !== bytes.length
    || bytes.readUInt16LE(6) !== 0) throw new Error('Unsupported junction reparse buffer.');
  if (symbolic && bytes.readUInt32LE(16) > 1) throw new Error('Unsupported symbolic link reparse flags.');
  const relative = symbolic && bytes.readUInt32LE(16) === 1;
  const readName = field => {
    const offset = bytes.readUInt16LE(field);
    const count = bytes.readUInt16LE(field + 2);
    if (offset % 2 || count % 2 || start + offset + count > bytes.length) throw new Error('Invalid junction reparse name.');
    const value = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start + offset, start + offset + count));
    if (/[\0\r\n]/.test(value)) throw new Error('Invalid junction reparse name.');
    return value;
  };
  const parent = path.win32.dirname(path.win32.join(project, name));
  const resolve = (value, substitute) => {
    if (!value) throw new Error('Empty directory link reparse target.');
    if (relative) {
      if (path.win32.isAbsolute(value) || value.includes(':')) throw new Error('Rooted relative reparse target.');
      value = path.win32.resolve(parent, value);
    } else if (substitute) {
      if (!value.startsWith('\\??\\')) throw new Error('Unsupported junction reparse namespace.');
      value = value.slice(4);
    } else if (value.startsWith('\\\\?\\')) value = value.slice(4);
    if (!/^[a-z]:\\/i.test(value) || path.win32.resolve(value) !== value) throw new Error('Invalid directory link target.');
    return value;
  };
  const absolute = resolve(readName(8), true);
  const display = readName(12);
  if (display && resolve(display, false).toLowerCase() !== absolute.toLowerCase()) throw new Error('Invalid junction reparse target.');
  const location = path.win32.relative(project, absolute).replaceAll('\\', '/');
  if (!location || location === '..' || location.startsWith('../') || path.win32.isAbsolute(location)) {
    throw new Error('Junction target is outside the original project.');
  }
  return { location, target: path.win32.relative(parent, absolute).replaceAll('\\', '/') };
}

export function validateWindowsSnapshotSecurity(value, inventory, project) {
  const record = captureWorkerFields(value, ['version', 'descriptors', 'root', 'entries',
    ...(value?.version === 2 ? ['project', 'junctions', ...(Object.hasOwn(value, 'symlinks') ? ['symlinks'] : [])] : [])],
  'Windows snapshot security');
  if (![1, 2].includes(record.version) || !Array.isArray(record.descriptors) || !record.descriptors.length
    || record.descriptors.length > inventory.length + 1 || !record.descriptors.every(descriptor)
    || new Set(record.descriptors).size !== record.descriptors.length
    || !Array.isArray(record.entries) || record.entries.length !== inventory.length) {
    throw new Error('Invalid Windows snapshot security table.');
  }
  const used = new Set();
  const capture = (value, kind, keys) => {
    const item = captureWorkerFields(value, keys, 'Windows snapshot security entry');
    if (!Number.isSafeInteger(item.security) || item.security < 0 || item.security >= record.descriptors.length
      || !attributes(item.attributes, kind)) throw new Error('Invalid Windows snapshot security reference or attributes.');
    used.add(item.security);
    return Object.freeze(item);
  };
  const root = capture(record.root, 'directory', ['security', 'attributes']);
  const entries = record.entries.map((value, index) => {
    const source = inventory[index];
    if (!['file', 'directory', ...(record.version === 2 ? ['link'] : [])].includes(source.kind)) {
      throw new Error('Windows snapshot links require native ACL/reparse support.');
    }
    const item = capture(value, source.kind, ['path', 'security', 'attributes']);
    if (item.path !== source.path) throw new Error('Windows snapshot security inventory differs.');
    return item;
  });
  if (used.size !== record.descriptors.length) throw new Error('Unused Windows snapshot security descriptors.');
  let junctions, symlinks;
  if (record.version === 2) {
    if (typeof record.project !== 'string' || record.project.length > 4096 || !/^[a-z]:\\/i.test(record.project)
      || /[\0\r\n]/.test(record.project) || path.win32.resolve(record.project) !== record.project
      || project !== undefined && record.project !== project) throw new Error('Invalid original junction project binding.');
    const links = inventory.filter(entry => entry.kind === 'link');
    const targets = new Map(inventory.map(entry => [entry.path.toLowerCase(), entry.kind]));
    const linkIndexes = new Map(links.map((entry, index) => [entry.path, index]));
    const seen = new Set();
    const hasSymlinks = Object.hasOwn(record, 'symlinks');
    if (!links.length || !Array.isArray(record.junctions)
      || hasSymlinks && (!Array.isArray(record.symlinks) || !record.symlinks.length)
      || record.junctions.length + (record.symlinks?.length ?? 0) !== links.length) {
      throw new Error('Invalid junction metadata inventory.');
    }
    const captureLinks = (values, kind) => {
      let previous = -1;
      return Object.freeze(values.map(value => {
        const item = captureWorkerFields(value, ['path', 'data'], 'junction metadata');
        const index = linkIndexes.get(item.path);
        if (index === undefined || index <= previous || seen.has(item.path)) throw new Error('Junction metadata path differs.');
        previous = index;
        seen.add(item.path);
        const entry = links[index];
        const decoded = directoryLinkTarget(record.project, entry.path, item.data, kind);
        if (decoded.target !== entry.target || targets.get(decoded.location.toLowerCase()) !== 'directory') {
          throw new Error('Junction target is not the captured regular directory.');
        }
        return Object.freeze(item);
      }));
    };
    junctions = captureLinks(record.junctions, 'junction');
    if (hasSymlinks) symlinks = captureLinks(record.symlinks, 'directory-symlink');
  }
  return Object.freeze({ version: record.version,
    ...(junctions ? { project: record.project, junctions, ...(symlinks ? { symlinks } : {}) } : {}),
    descriptors: Object.freeze([...record.descriptors]), root, entries: Object.freeze(entries) });
}

function nativeMetadata(value, kind, keys) {
  const record = captureWorkerFields(value, keys, 'native snapshot security');
  if (!descriptor(record.securityDescriptor) || !attributes(record.attributes, kind)) {
    throw new Error('Unsupported native snapshot source security.');
  }
  return record;
}

export async function inspectWindowsSnapshotSecurity({ project, destinationParent, entries, signal, pwsh = 'pwsh.exe', onProgress }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![project, destinationParent].every(canonical)
    || !Array.isArray(entries) || entries.length > 250000
    || onProgress !== undefined && typeof onProgress !== 'function') throw refused(new Error('Invalid Windows snapshot scope.'));
  const inventory = entries.map(({ path: name, kind }) => {
    if (typeof name !== 'string' || !name || name.length > 4096 || /[\\:\0\r\n]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')
      || !['file', 'directory', 'link'].includes(kind)) throw new Error('Windows snapshot paths require native ACL/reparse support.');
    return Object.freeze({ path: name, kind });
  });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original snapshot controller identity is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native snapshot security observer',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Project', project,
      '-DestinationParent', destinationParent, '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'project', 'destinationParent', 'root'], 'snapshot security readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)
      || ready.project !== project || ready.destinationParent !== destinationParent) {
      throw new Error('Original snapshot security observer differs.');
    }
    const root = nativeMetadata(ready.root, 'directory', ['securityDescriptor', 'attributes']);
    const request = async (method, batch, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new Error('Snapshot security observer is closed.');
      const id = ++sequence;
      await wire.send({ id, method, entries: batch });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
        ['id', 'type', 'processIdentity', 'value'], 'snapshot security acknowledgement');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
        throw new Error('Unexpected snapshot security acknowledgement.');
      }
      return reply.value;
    };
    const collect = async requestSignal => {
      const descriptors = [root.securityDescriptor];
      const indexes = new Map([[root.securityDescriptor, 0]]);
      const records = [];
      const junctions = [];
      const symlinks = [];
      let metadataBytes = Buffer.byteLength(root.securityDescriptor);
      let reported = 0;
      if (inventory.length >= 1024) onProgress?.({ phase: 'snapshot-native-security', completed: 0, total: inventory.length });
      for (let offset = 0; offset < inventory.length;) {
        const batch = [];
        let budget = 0;
        while (offset < inventory.length && batch.length < 8) {
          const cost = Buffer.byteLength(JSON.stringify(inventory[offset])) + 8192 + 128
            + (inventory[offset].kind === 'link' ? 21848 : 0);
          if (batch.length && budget + cost > 110000) break;
          batch.push(inventory[offset++]);
          budget += cost;
        }
        const values = await request('capture', batch, requestSignal);
        if (!Array.isArray(values) || values.length !== batch.length) throw new Error('Snapshot source security inventory changed.');
        for (const [index, value] of values.entries()) {
          const expected = batch[index];
          const item = nativeMetadata(value, expected.kind, ['path', 'kind', 'attributes', 'securityDescriptor',
            ...(expected.kind === 'link' ? ['data', 'linkKind'] : [])]);
          if (item.path !== expected.path || item.kind !== expected.kind) throw new Error('Snapshot source security path changed.');
          if (!indexes.has(item.securityDescriptor)) {
            indexes.set(item.securityDescriptor, descriptors.length);
            descriptors.push(item.securityDescriptor);
            metadataBytes += Buffer.byteLength(item.securityDescriptor);
          }
          const record = { path: item.path, security: indexes.get(item.securityDescriptor), attributes: item.attributes };
          if (expected.kind === 'link') {
            const junction = { path: item.path, data: item.data };
            if (item.linkKind === 'junction') junctions.push(junction);
            else if (item.linkKind === 'directory-symlink') symlinks.push(junction);
            else throw new Error('Unsupported native directory link kind.');
            metadataBytes += Buffer.byteLength(JSON.stringify(junction));
          }
          metadataBytes += Buffer.byteLength(JSON.stringify(record));
          if (metadataBytes > 32 * 1024 * 1024) throw new Error('Snapshot source security metadata exceeds its budget.');
          records.push(record);
        }
        if (inventory.length >= 1024 && (offset === inventory.length || offset - reported >= Math.ceil(inventory.length / 4))) {
          onProgress?.({ phase: 'snapshot-native-security', completed: offset, total: inventory.length });
          reported = offset;
        }
      }
      const final = await request('capture', [], requestSignal);
      if (!Array.isArray(final) || final.length) throw new Error('Unexpected snapshot security final acknowledgement.');
      return validateWindowsSnapshotSecurity({
        version: junctions.length || symlinks.length ? 2 : 1,
        ...(junctions.length || symlinks.length ? { project, junctions, ...(symlinks.length ? { symlinks } : {}) } : {}),
        descriptors, root: { security: 0, attributes: root.attributes }, entries: records,
      }, entries, project);
    };
    const metadata = await collect(signal);
    const invoke = async (closing, requestSignal) => {
      if (busy) throw refused(new Error('Snapshot security observation is active.'));
      if (closed) {
        if (closing) return;
        throw refused(new Error('Snapshot security observation is closed.'));
      }
      busy = true;
      try {
        if (closing) {
          if (await request('close', [], requestSignal) !== 'close') throw new Error('Unexpected snapshot security close reply.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Snapshot security close failed.');
          closed = true;
          wire.close();
        } else if (!same(await collect(requestSignal), metadata)) {
          throw new Error('Snapshot source ACL or attributes changed.');
        }
      } catch (cause) {
        closed = true;
        throw await abandon(cause);
      } finally { busy = false; }
    };
    return Object.freeze({
      metadata, check: ({ signal: checkSignal = signal } = {}) => invoke(false, checkSignal),
      close: () => invoke(true),
    });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
