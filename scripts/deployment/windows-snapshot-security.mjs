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
const attributes = (value, kind) => Number.isInteger(value) && value >= 0 && value <= supportedAttributes
  && !(value & ~supportedAttributes) && Boolean(value & 16) === (kind === 'directory');
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const refused = cause => new Error('Windows snapshot source security observation refused.', { cause });

export function validateWindowsSnapshotSecurity(value, inventory) {
  const record = captureWorkerFields(value, ['version', 'descriptors', 'root', 'entries'], 'Windows snapshot security');
  if (record.version !== 1 || !Array.isArray(record.descriptors) || !record.descriptors.length
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
    if (!['file', 'directory'].includes(source.kind)) throw new Error('Windows snapshot links require native ACL/reparse support.');
    const item = capture(value, source.kind, ['path', 'security', 'attributes']);
    if (item.path !== source.path) throw new Error('Windows snapshot security inventory differs.');
    return item;
  });
  if (used.size !== record.descriptors.length) throw new Error('Unused Windows snapshot security descriptors.');
  return Object.freeze({ version: 1, descriptors: Object.freeze([...record.descriptors]), root, entries: Object.freeze(entries) });
}

function nativeMetadata(value, kind, keys) {
  const record = captureWorkerFields(value, keys, 'native snapshot security');
  if (!descriptor(record.securityDescriptor) || !attributes(record.attributes, kind)) {
    throw new Error('Unsupported native snapshot source security.');
  }
  return record;
}

export async function inspectWindowsSnapshotSecurity({ project, destinationParent, entries, signal, pwsh = 'pwsh.exe' }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![project, destinationParent].every(canonical)
    || !Array.isArray(entries) || entries.length > 250000) throw refused(new Error('Invalid Windows snapshot scope.'));
  const inventory = entries.map(({ path: name, kind }) => {
    if (typeof name !== 'string' || !name || name.length > 4096 || /[\\:\0\r\n]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..')
      || !['file', 'directory'].includes(kind)) throw new Error('Windows snapshot paths require native ACL/reparse support.');
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
      let metadataBytes = Buffer.byteLength(root.securityDescriptor);
      for (let offset = 0; offset < inventory.length;) {
        const batch = [];
        let budget = 0;
        while (offset < inventory.length && batch.length < 8) {
          const cost = Buffer.byteLength(JSON.stringify(inventory[offset])) + 8192 + 128;
          if (batch.length && budget + cost > 110000) break;
          batch.push(inventory[offset++]);
          budget += cost;
        }
        const values = await request('capture', batch, requestSignal);
        if (!Array.isArray(values) || values.length !== batch.length) throw new Error('Snapshot source security inventory changed.');
        for (const [index, value] of values.entries()) {
          const expected = batch[index];
          const item = nativeMetadata(value, expected.kind, ['path', 'kind', 'attributes', 'securityDescriptor']);
          if (item.path !== expected.path || item.kind !== expected.kind) throw new Error('Snapshot source security path changed.');
          if (!indexes.has(item.securityDescriptor)) {
            indexes.set(item.securityDescriptor, descriptors.length);
            descriptors.push(item.securityDescriptor);
            metadataBytes += Buffer.byteLength(item.securityDescriptor);
          }
          const record = { path: item.path, security: indexes.get(item.securityDescriptor), attributes: item.attributes };
          metadataBytes += Buffer.byteLength(JSON.stringify(record));
          if (metadataBytes > 32 * 1024 * 1024) throw new Error('Snapshot source security metadata exceeds its budget.');
          records.push(record);
        }
      }
      const final = await request('capture', [], requestSignal);
      if (!Array.isArray(final) || final.length) throw new Error('Unexpected snapshot security final acknowledgement.');
      return validateWindowsSnapshotSecurity({
        version: 1, descriptors, root: { security: 0, attributes: root.attributes }, entries: records,
      }, inventory);
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
