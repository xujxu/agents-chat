import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureActivatedRuntime, captureTaskListener, windowsTaskCompletionSteps } from './windows-task-controller.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { captureWindowsColdActivationHistory } from './windows-cold-activation-history.mjs';
import {
  captureWindowsColdRuntimeCompletion, captureWindowsColdCompletionPrefix, windowsColdCompletionPhases,
} from './windows-cold-runtime-completion.mjs';
import { validateReadinessProviders } from './http-readiness.mjs';

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
  let completed;
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
      if (result.status !== (completed ? 'released-running' : 'guarded-running') || result.taskName !== taskName
        || result.controllerPid !== ready.pid || result.controllerIdentity !== ready.processIdentity
        || result.configuration !== runtimeBundle.configuration || runtime.configurationSha256 !== runtimeBundle.sha256
        || runtime.generation === originalGeneration
        || ![result.definition, result.securityDescriptor].every(value => typeof value === 'string'
          && value.length > 0 && value.length <= 262144 && !value.includes('\0'))) {
        throw new Error('Cold guarded runtime differs from its original intent.');
      }
      return Object.freeze({ ...result, runtime: Object.freeze(runtime) });
    };
    const checkHistory = async (phase, expected) => {
      const directory = path.join(control, 'recovery-lock');
      const intentBytes = await readWorkerFile(path.join(directory, 'activation-intent.json'),
        65536, { privateMode: true });
      if (createHash('sha256').update(intentBytes).digest('hex') !== intentSha256) {
        throw new Error('Original cold activation intent changed before acknowledgement.');
      }
      const intent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(intentBytes));
      if (intent.ownerSha256 !== ownerSha256 || intent.filesReceiptSha256 !== receiptSha256
        || !same(intent.runtimeBundle, runtimeBundle)) {
        throw new Error('Cold activation journal differs from the admitted owner or runtime bundle.');
      }
      const phases = ['start-requested', 'running', ...(phase === 'stopped' ? ['stopped'] : [])];
      const records = await Promise.all(phases.map(name =>
        readWorkerFile(path.join(directory, `activation-${name}.json`), 4194304, { privateMode: true })));
      const history = captureWindowsColdActivationHistory({ intent, intentBytes, records, taskName });
      const last = history.records.at(-1);
      if (history.phase !== phase || history.controllerPid !== ready.pid
        || history.controllerIdentity !== ready.processIdentity || !same(history.runtime, expected.runtime)
        || last.definition !== expected.definition || last.securityDescriptor !== expected.securityDescriptor) {
        throw new Error('Cold activation acknowledgement differs from its durable native journal.');
      }
    };
    const exchange = async (method, requestSignal, options) => {
      await assertWindowsAdmission(control, admission, { signal: requestSignal });
      const id = ++sequence;
      await bridge.wire.send({ id, method, ...options });
      const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 120000 }),
        ['id', 'type', 'processIdentity', 'value'], 'cold startup acknowledgement');
      if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
        throw new Error('Cold startup acknowledgement differs.');
      }
      return reply.value;
    };
    const request = async (method, requestSignal, options = {}, onProgress) => {
      requestSignal?.throwIfAborted();
      if (closed || busy) throw new Error('Cold guarded startup is closed or busy.');
      if (method === 'start' && running) throw new Error('Cold guarded runtime is already started.');
      if (method === 'listener' && (!running || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)) {
        throw new Error('Cold listener requires a started runtime and valid port.');
      }
      if (method === 'complete') {
        if (onProgress !== undefined && typeof onProgress !== 'function') {
          throw new TypeError('Cold completion progress callback must be a function.');
        }
        if (!running || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
          throw new Error('Cold completion requires a started runtime and valid port.');
        }
        validateReadinessProviders(options.providers);
        if (completed && (completed.port !== options.port || !same(completed.providers, options.providers))) {
          throw new Error('Original cold completion readiness differs.');
        }
      }
      busy = true;
      try {
        if (method === 'complete') {
          let phase;
          for (const step of completed ? ['complete'] : windowsTaskCompletionSteps) {
            const value = await exchange(method, requestSignal, options);
            const binding = {
              control, running, ownerSha256, receiptSha256, intentSha256,
              port: options.port, providers: options.providers, signal: requestSignal,
            };
            if (step === 'complete') {
              completed = await captureWindowsColdRuntimeCompletion({ ...binding, value });
            } else {
              const progress = captureWorkerFields(value,
                ['status', 'step', 'lease', 'completionSha256'], 'cold completion progress');
              const released = windowsTaskCompletionSteps.indexOf(step) >= windowsTaskCompletionSteps.indexOf('lease-released');
              if (progress.status !== 'runtime-policy-progress' || progress.step !== step
                || progress.lease !== (released ? 'released' : 'guarded')) {
                throw new Error('Cold completion skipped its original finite transition.');
              }
              if (windowsColdCompletionPhases.includes(step)) phase = step;
              const prefix = await captureWindowsColdCompletionPrefix({ ...binding, phase });
              if (prefix.sha256 !== progress.completionSha256) {
                throw new Error('Cold completion progress differs from its durable receipt prefix.');
              }
            }
            await assertWindowsAdmission(control, admission, { signal: requestSignal });
            await onProgress?.(Object.freeze({ step, lease: value.lease, completionSha256: value.completionSha256 }));
            requestSignal?.throwIfAborted();
          }
          return completed;
        }
        const value = await exchange(method, requestSignal, options);
        if (method === 'close') {
          if (value !== 'close') throw new Error('Cold startup close acknowledgement differs.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Cold startup bridge did not close cleanly.');
          if (running && !completed) await checkHistory('stopped', running);
          closed = true;
          bridge.wire.close();
          return;
        }
        if (method === 'listener') {
          const listener = captureTaskListener(value, running.runtime, options.port);
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
          return Object.freeze(listener);
        }
        const current = capture(value);
        const expected = completed ? { ...running, status: 'released-running', definition: completed.definition } : running;
        if (running && !same(current, expected)) throw new Error('Original cold runtime changed outside acknowledged completion.');
        if (method === 'start') await checkHistory('running', current);
        running ??= current;
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return current;
      } catch (cause) {
        closed = true;
        throw await bridge.abandon(cause);
      } finally { busy = false; }
    };
    return Object.freeze({
      start: ({ signal } = {}) => request('start', signal),
      check: ({ signal } = {}) => request('check', signal),
      listener: ({ port, signal }) => request('listener', signal, { port }),
      completeRuntime: ({ port, providers, signal, onProgress }) => request('complete', signal, { port, providers }, onProgress),
      close: async () => { if (!closed) await request('close'); },
    });
  } catch (cause) {
    closed = true;
    throw await bridge.abandon(cause);
  }
}
