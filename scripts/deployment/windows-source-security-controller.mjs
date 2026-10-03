import { createHash } from 'node:crypto';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

export const redactedWindowsPolicy = value => String(value).replace(/S-1-[0-9-]+/g,
  sid => `<sid:${createHash('sha256').update(sid).digest('hex').slice(0, 12)}>`);

export async function openWindowsSourceSecurityController({
  project, backup, metadata, savedEntries, currentEntries, signal, pwsh, script, refused, decodeReply,
}) {
  signal?.throwIfAborted();
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original source restore controller is unavailable.'));
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native source security restoration',
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
      throw new Error('Original source restore controller differs.');
    }
    const root = captureWorkerFields(ready.root, ['securityDescriptor', 'attributes'], 'restore root security');
    if (root.securityDescriptor !== metadata.descriptors[metadata.root.security] || root.attributes !== metadata.root.attributes) {
      const error = new Error('Original source root security policy or attributes differ from the snapshot.');
      error.comparison = {
        expectedAttributes: metadata.root.attributes, observedAttributes: root.attributes,
        expectedPolicy: redactedWindowsPolicy(metadata.descriptors[metadata.root.security]),
        observedPolicy: redactedWindowsPolicy(root.securityDescriptor),
      };
      throw error;
    }
    const request = async (method, entries, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || child.exitCode !== null || child.signalCode !== null) throw new Error('Source security controller is closed.');
      const id = ++sequence;
      await wire.send({ id, method, entries });
      const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 60000 }),
        ['id', 'type', 'processIdentity', 'value'], 'restore security acknowledgement');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
        throw new Error('Unexpected source security acknowledgement.');
      }
      if (decodeReply) return decodeReply(method, reply.value);
      if (reply.value !== method) throw new Error('Unexpected source security acknowledgement.');
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
      if (busy) throw refused(new Error('Source security restoration is active.'));
      if (closed) {
        if (method === 'close') return;
        throw refused(new Error('Source security restoration is closed.'));
      }
      busy = true;
      try {
        const result = await request(method, entries, method === 'close' ? undefined : requestSignal);
        if (method === 'close') {
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Source security controller close failed.');
          closed = true;
          wire.close();
        }
        return result;
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
    return Object.freeze({ invoke, applyEntries });
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}
