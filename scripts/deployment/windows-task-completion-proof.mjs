import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';
import { captureWindowsTaskRetirement } from './windows-task-retirement-record.mjs';
import { captureWindowsTaskRetirementCheckpoint } from './windows-task-retirement-checkpoint.mjs';
import { captureWindowsTaskRetirementScope } from './windows-task-retirement-scope.mjs';

export { captureWindowsTaskCompletionProof } from './windows-task-completion-record.mjs';

const script = fileURLToPath(new URL('./windows-task-completion-controller.ps1', import.meta.url));
const proofs = new WeakMap();
const retirements = new WeakMap();
function refused(cause) {
  return Object.assign(new Error('Completed-task proof unavailable; retain operation and recovery evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_COMPLETION_PROOF_REFUSED', recoveryAllowed: false,
  });
}

function bindingFor(control, proof, admission) {
  const binding = proofs.get(proof);
  if (!binding || binding.control !== control || binding.admission !== admission) {
    throw new Error('Original retained completed-task proof does not match admission.');
  }
  return binding;
}

export async function assertWindowsTaskCompletionProof(control, proof, admission, options) {
  bindingFor(control, proof, admission);
  return proof.check(options);
}

export async function prepareWindowsTaskRetirement(control, proof, admission, { signal } = {}) {
  return bindingFor(control, proof, admission).prepare(signal);
}

export async function prepareWindowsTaskRetirementCheckpoint(control, proof, admission, { signal } = {}) {
  return bindingFor(control, proof, admission).prepareCheckpoint(signal);
}

export async function beginWindowsTaskRetirement(control, proof, admission, { signal } = {}) {
  return bindingFor(control, proof, admission).begin(signal);
}

export async function retireNextWindowsTaskFile(control, scope, admission, { signal } = {}) {
  const binding = retirements.get(scope);
  if (!binding || binding.control !== control || binding.admission !== admission) {
    throw new Error('Original retained task retirement authority does not match admission.');
  }
  return binding.next(signal);
}

export async function openWindowsTaskCompletionProof(options) {
  return openWindowsTaskAuthority(options, false);
}

export async function openWindowsTaskRetirement(options) {
  return openWindowsTaskAuthority(options, true);
}

async function openWindowsTaskAuthority({ control, pwsh, admission, signal }, retiring) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value =>
    typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
    && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Explicit canonical Windows control and PowerShell paths are required.'));
  }
  await assertWindowsAdmission(control, admission, { signal });
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original Node controller identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon: abandonTransport } = windowsControllerTransport({
    pwsh, refused, label: 'Native completed-task proof controller',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity,
      ...(retiring ? ['-Retirement'] : [])],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  const abandon = async cause => {
    closed = true;
    failure = await abandonTransport(cause);
    return failure;
  };
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'completed-task proof readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original completed-task proof readiness differs.');
    }
    let retirementObservation = retiring ? captureWindowsTaskRetirementScope(ready.value) : undefined;
    const observation = retirementObservation?.checkpoint.intent.intent.completion
      ?? captureWindowsTaskCompletionProof(ready.value);
    if (retirementObservation && retirementObservation.checkpoint.intent.intent.control !== control) {
      throw new Error('Retirement readiness control differs.');
    }
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const requireOriginalChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Original completed-task proof controller exited.');
      }
    };
    const request = async (method, requestSignal) => {
      if (busy) throw refused(new Error('A completed-task proof request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Completed-task proof is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (method !== 'close') await assertWindowsAdmission(control, admission, { signal: requestSignal });
        requireOriginalChild();
        const id = ++sequence;
        await wire.send({ id, method });
        const reply = captureWorkerFields(await wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'completed-task proof reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected completed-task proof acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected completed-task proof close acknowledgement.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Native completed-task proof close failed.');
          closed = true;
          wire.close();
          return;
        }
        let result;
        let prepared;
        let nextRetirement;
        if (retiring || method === 'begin-retirement') {
          result = nextRetirement = captureWindowsTaskRetirementScope(reply.value);
          prepared = result.checkpoint.intent;
          if (retirementObservation) {
            const expected = retirementObservation.retiredFiles + (method === 'retire-next' ? 1 : 0);
            if (result.retiredFiles !== expected
              || !isDeepStrictEqual(result.checkpoint, retirementObservation.checkpoint)) {
              throw new Error('Original retirement checkpoint or ordered progress changed.');
            }
          } else if (result.retiredFiles !== 0) {
            throw new Error('Full-proof transfer cannot begin after missing receipts.');
          }
        } else if (method === 'prepare-retirement-checkpoint') {
          result = captureWindowsTaskRetirementCheckpoint(reply.value);
          prepared = result.intent;
        } else if (method === 'prepare-retirement') {
          result = prepared = captureWindowsTaskRetirement(reply.value);
        }
        if (prepared && prepared.intent.control !== control) throw new Error('Retirement intent control differs.');
        const observed = prepared ? prepared.intent.completion : captureWindowsTaskCompletionProof(reply.value);
        if (!isDeepStrictEqual(observed, observation)) throw new Error('Original completed-task proof observation changed.');
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        requireOriginalChild();
        if (nextRetirement) {
          retiring = true;
          retirementObservation = nextRetirement;
        }
        return result ?? observed;
      } catch (cause) { throw await abandon(cause); }
      finally { busy = false; }
    };
    await request('check', signal);
    const requireMode = expected => {
      if (retiring !== expected) throw refused(new Error('Original proof was transferred to retirement authority.'));
    };
    const contextFor = retirement => Object.freeze({
      identity, observation: retirement ? retirementObservation : observation,
      async check({ signal: checkSignal } = {}) {
        requireMode(retirement);
        return request('check', checkSignal);
      },
      async close() {
        requireMode(retirement);
        if (busy) throw refused(new Error('Cannot close an active completed-task proof request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
    const retirementContext = () => {
      const scope = contextFor(true);
      retirements.set(scope, { control, admission, async next(requestSignal) {
        requireMode(true);
        if (retirementObservation.retiredFiles >= retirementObservation.checkpoint.intent.intent.files.length) {
          throw refused(new Error('Retirement receipt list is exhausted.'));
        }
        return request('retire-next', requestSignal);
      } });
      return scope;
    };
    if (retiring) return retirementContext();
    const proof = contextFor(false);
    const fullRequest = (method, requestSignal) => {
      requireMode(false);
      return request(method, requestSignal);
    };
    proofs.set(proof, { control, admission,
      prepare: requestSignal => fullRequest('prepare-retirement', requestSignal),
      prepareCheckpoint: requestSignal => fullRequest('prepare-retirement-checkpoint', requestSignal),
      async begin(requestSignal) {
        await fullRequest('begin-retirement', requestSignal);
        return retirementContext();
      } });
    return proof;
  } catch (cause) { throw await abandon(cause); }
}
