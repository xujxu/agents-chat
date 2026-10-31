import { fileURLToPath } from 'node:url';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-cold-restore-retirement.ps1', import.meta.url));
const refused = cause => Object.assign(new Error('Cold runtime retirement refused; retain original recovery evidence.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED', recoveryAllowed: false,
});

export async function retireWindowsColdRestoreOwner({
  control, pwsh, admission, ownerSha256, receiptSha256, signal,
}) {
  signal?.throwIfAborted();
  await assertWindowsAdmission(control, admission, { signal });
  if (![ownerSha256, receiptSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw refused(new Error('Cold retirement requires exact owner and completed-file receipt digests.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original cold retirement controller is unavailable.'));
  const bridge = windowsControllerTransport({
    pwsh, refused, label: 'Native cold runtime retirement',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-OwnerSha256', ownerSha256, '-ReceiptSha256', receiptSha256,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  try {
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'control', 'ownerSha256', 'receiptSha256'],
      'cold runtime retirement readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid) || ready.control !== control
      || ready.ownerSha256 !== ownerSha256 || ready.receiptSha256 !== receiptSha256) {
      throw new Error('Original cold runtime retirement bridge differs.');
    }
    await assertWindowsAdmission(control, admission, { signal });
    await bridge.wire.send({ id: 1, method: 'retire' });
    const reply = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['id', 'type', 'value', 'processIdentity'], 'cold runtime retirement acknowledgement');
    if (reply.id !== 1 || reply.type !== 'reply' || reply.value !== 'retired'
      || reply.processIdentity !== ready.processIdentity) {
      throw new Error('Original cold runtime retirement acknowledgement differs.');
    }
    const result = await bridge.waitForExit();
    if (result.code !== 0 || result.signal !== null) throw new Error('Native cold retirement did not close cleanly.');
    bridge.wire.close();
    await assertWindowsAdmission(control, admission, { signal });
  } catch (cause) { throw await bridge.abandon(cause); }
}
