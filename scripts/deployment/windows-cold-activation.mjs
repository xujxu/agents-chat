import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-cold-activation.ps1', import.meta.url));
const refused = cause => Object.assign(new Error('Cold guarded startup refused; preserve activation evidence.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_REFUSED', recoveryAllowed: false,
});

export async function openWindowsColdActivation({
  control, pwsh, admission, ownerSha256, receiptSha256, intentSha256, taskName, runtimeBundle, originalGeneration, signal,
}) {
  signal?.throwIfAborted();
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original cold startup controller identity is unavailable.'));
  const bridge = windowsControllerTransport({
    pwsh, refused, label: 'Native cold guarded startup',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-OwnerSha256', ownerSha256, '-ReceiptSha256', receiptSha256, '-IntentSha256', intentSha256,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let running;
  try {
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'control', 'ownerSha256', 'receiptSha256', 'intentSha256'],
      'cold startup readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid) || ready.control !== control
      || ready.ownerSha256 !== ownerSha256 || ready.receiptSha256 !== receiptSha256 || ready.intentSha256 !== intentSha256) {
      throw new Error('Original cold startup bridge readiness differs.');
    }
    const capture = value => {
      const result = captureWorkerFields(value, ['status', 'taskName', 'runtime', 'controllerPid', 'controllerIdentity',
        'configuration', 'definition', 'securityDescriptor'], 'cold guarded runtime');
      const runtime = captureActivatedRuntime(result.runtime);
      if (result.status !== 'guarded-running' || result.taskName !== taskName
        || result.controllerPid !== ready.pid || result.controllerIdentity !== ready.processIdentity
        || result.configuration !== runtimeBundle.configuration || runtime.configurationSha256 !== runtimeBundle.sha256
        || runtime.generation === originalGeneration
        || ![result.definition, result.securityDescriptor].every(value => typeof value === 'string'
          && value.length > 0 && value.length <= 262144 && !value.includes('\0'))) {
        throw new Error('Cold guarded runtime differs from its original intent.');
      }
      return Object.freeze({ ...result, runtime: Object.freeze(runtime) });
    };
    const request = async (method, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || busy) throw new Error('Cold guarded startup is closed or busy.');
      if (method === 'start' && running) throw new Error('Cold guarded runtime is already started.');
      busy = true;
      try {
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        const id = ++sequence;
        await bridge.wire.send({ id, method });
        const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 120000 }),
          ['id', 'type', 'processIdentity', 'value'], 'cold startup acknowledgement');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
          throw new Error('Cold startup acknowledgement differs.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Cold startup close acknowledgement differs.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Cold startup bridge did not close cleanly.');
          closed = true;
          bridge.wire.close();
          return;
        }
        const current = capture(reply.value);
        if (running && !same(current, running)) throw new Error('Original cold guarded runtime changed.');
        running = current;
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return running;
      } catch (cause) {
        closed = true;
        throw await bridge.abandon(cause);
      } finally { busy = false; }
    };
    return Object.freeze({
      start: ({ signal } = {}) => request('start', signal),
      check: ({ signal } = {}) => request('check', signal),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await bridge.abandon(cause);
  }
}
