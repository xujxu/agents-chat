import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-cold-restore-publication.ps1', import.meta.url));
const refused = cause => Object.assign(new Error('Cold restore lease publication refused; retain staged evidence.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_LEASE_PUBLICATION_REFUSED', recoveryAllowed: false,
});

export async function publishWindowsColdRestoreStaging({ control, pwsh, admission, signal, makeRecord }) {
  signal?.throwIfAborted();
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original cold lease publisher identity is unavailable.'));
  const bridge = windowsControllerTransport({
    pwsh, refused, label: 'Native cold lease publisher',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  try {
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'directory'], 'cold lease publication readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid)
      || ready.directory !== path.join(control, 'cold-restore-staging')) {
      throw new Error('Original cold lease publisher readiness differs.');
    }
    await assertWindowsAdmission(control, admission, { signal });
    const record = await makeRecord();
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > 65536) throw new Error('Cold restore owner exceeds the supported evidence budget.');
    await bridge.wire.send({ id: 1, method: 'publish', record: bytes.toString('utf8') });
    const published = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 30000 }),
      ['id', 'type', 'value', 'processIdentity'], 'cold lease publication acknowledgement');
    if (published.id !== 1 || published.type !== 'reply' || published.processIdentity !== ready.processIdentity
      || published.value !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('Native cold restore owner publication differs.');
    }
    await assertWindowsAdmission(control, admission, { signal });
    await bridge.wire.send({ id: 2, method: 'close' });
    const reply = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 30000 }),
      ['id', 'type', 'value', 'processIdentity'], 'cold lease publisher close');
    if (reply.id !== 2 || reply.type !== 'reply' || reply.value !== 'close' || reply.processIdentity !== ready.processIdentity) {
      throw new Error('Unexpected cold lease publisher close acknowledgement.');
    }
    const result = await bridge.waitForExit();
    if (result.code !== 0 || result.signal !== null) throw new Error('Native cold lease publisher did not close cleanly.');
    bridge.wire.close();
    await assertWindowsAdmission(control, admission, { signal });
    return { record, bytes };
  } catch (cause) { throw await bridge.abandon(cause); }
}
