import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { captureTaskListener, captureActivatedRuntime } from './windows-task-controller.mjs';
import {
  captureWindowsManagedTaskObservation, captureWindowsInactiveTaskObservation,
} from './windows-managed-task-observation.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { assertLockOwner, captureLockOwner, validateState } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { assertWindowsAdmission } from './windows-admission.mjs';
import { createWindowsInactiveTaskAdmissionRecord } from './windows-inactive-task-admission.mjs';

const script = fileURLToPath(new URL('./windows-managed-task-controller.ps1', import.meta.url));
const scopes = new WeakMap();
const inactiveScopes = new WeakMap();
const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const task = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(value);
function refused(cause) {
  return Object.assign(new Error('Managed Windows task discovery refused; retain the existing deployment.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED', runtimeAuthority: false,
  });
}
export async function inspectWindowsManagedTask({ taskName, project, pwsh, signal }) {
  return inspectTask({ taskName, project, pwsh, signal }, false);
}

export async function inspectWindowsInactiveTask({ taskName, project, pwsh, signal }) {
  return inspectTask({ taskName, project, pwsh, signal }, true);
}

async function inspectTask({ taskName, project, pwsh, signal }, inactive) {
  const capture = inactive ? captureWindowsInactiveTaskObservation : captureWindowsManagedTaskObservation;
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !task(taskName) || !canonical(project) || !canonical(pwsh)) {
    throw refused(new Error('Canonical Windows project/PowerShell paths and an explicit task name are required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw refused(new Error('Original observer identity is unavailable.'));
  signal?.throwIfAborted();
  const { child, wire, waitForExit, abandon } = windowsControllerTransport({
    pwsh, refused, label: 'Native managed task observer',
    args: ['-NoProfile', '-NonInteractive', '-File', script, '-TaskName', taskName, '-Project', project,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity,
      ...(inactive ? ['-Inactive'] : [])],
  });
  let closed = false;
  let busy = false;
  let sequence = 0;
  let failure;
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'project', 'taskName', 'controllerIdentity', 'accountSid', 'sessionId', 'value'],
      'managed task readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.project !== project || ready.taskName !== taskName
      || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(child.pid)
      || typeof ready.accountSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(ready.accountSid)
      || !Number.isSafeInteger(ready.sessionId) || ready.sessionId < 0 || ready.sessionId > 2147483647) {
      throw new Error('Original managed task observer differs.');
    }
    const observation = capture(ready.value, project, taskName);
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity,
      accountSid: ready.accountSid, sessionId: ready.sessionId });
    const request = async (method, requestSignal, payload = {}) => {
      if (busy) throw refused(new Error('A managed task observation request is already active.'));
      if (failure) throw failure;
      if (closed) throw refused(new Error('Managed task observation is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (method === 'listener' && (!Number.isSafeInteger(payload.port) || payload.port < 1 || payload.port > 65535)) {
          throw new Error('Managed readiness requires an explicit valid port.');
        }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Original managed task observer exited.');
        const id = ++sequence;
        await wire.send({ id, method, ...payload });
        const reply = captureWorkerFields(await wire.receive({
          signal: requestSignal, timeoutMs: method === 'start-inactive' ? 60000 : 30000,
        }),
          ['id', 'type', 'value', 'processIdentity'], 'managed task reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== identity.processIdentity) {
          throw new Error('Unexpected managed task observation acknowledgement.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Unexpected managed task close acknowledgement.');
          const result = await waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Managed task observer close failed.');
          closed = true;
          wire.close();
          return;
        }
        if (method === 'listener') return captureTaskListener(reply.value, observation.runtime, payload.port);
        if (method === 'prepare-inactive-activation') {
          return Object.freeze(captureWorkerFields(reply.value, ['file', 'sha256'], 'inactive activation preparation'));
        }
        if (method === 'replace-inactive') {
          return Object.freeze(captureWorkerFields(reply.value,
            ['replaced', 'inhibited', 'definition', 'file', 'sha256'], 'inactive replacement'));
        }
        if (method === 'start-inactive') {
          return captureWorkerFields(reply.value, ['status', 'step', 'taskName', 'runtime', 'definition'], 'inactive startup');
        }
        if (method === 'capture-admission') {
          const result = captureWorkerFields(reply.value, ['admission', 'sha256'], 'managed task admission');
          if (result.admission !== path.join(payload.control, 'task-maintenance', 'admission.json')
            || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
            throw new Error('Unexpected managed task admission acknowledgement.');
          }
          return Object.freeze(result);
        }
        if (!isDeepStrictEqual(capture(reply.value, project, taskName), observation)) {
          throw new Error('Original managed task observation changed.');
        }
        return observation;
      } catch (cause) {
        closed = true;
        failure = await abandon(cause);
        throw failure;
      } finally { busy = false; }
    };
    const scope = Object.freeze({
      identity, observation,
      check: ({ signal: requestSignal } = {}) => request('check', requestSignal),
      ...(!inactive ? {
        listener: ({ port, signal: requestSignal } = {}) => request('listener', requestSignal, { port }),
      } : {}),
      close: async () => { if (!closed) await request('close'); },
    });
    (inactive ? inactiveScopes : scopes).set(scope, { observation, request });
    return scope;
  } catch (cause) {
    closed = true;
    throw await abandon(cause);
  }
}

export async function assertWindowsManagedTaskScope(scope, { signal } = {}) {
  const retained = scopes.get(scope);
  if (!retained) throw refused(new Error('Original retained managed task scope is required.'));
  return retained.request('check', signal);
}

export async function assertWindowsInactiveTaskScope(scope, { signal } = {}) {
  const retained = inactiveScopes.get(scope);
  if (!retained) throw refused(new Error('Original retained inactive task scope is required.'));
  return retained.request('check', signal);
}

export async function captureWindowsManagedTaskAdmission({ scope, control, lock: suppliedLock, admission, signal }) {
  return captureTaskAdmission({ scope, control, lock: suppliedLock, admission, signal }, false);
}

export async function captureWindowsInactiveTaskAdmission({ scope, control, lock, admission, signal }) {
  return captureTaskAdmission({ scope, control, lock, admission, signal }, true);
}

async function captureTaskAdmission({ scope, control, lock: suppliedLock, admission, signal }, inactive) {
  signal?.throwIfAborted();
  const retained = (inactive ? inactiveScopes : scopes).get(scope);
  if (!retained) throw refused(new Error('Original retained managed task scope is required.'));
  const lock = captureLockOwner(suppliedLock);
  const { root } = await externalWorkerDirectory(control, lock.project);
  if (retained.observation.project !== lock.project) throw refused(new Error('Managed task project differs.'));
  await assertWindowsAdmission(root, admission, { signal });
  await assertLockOwner(root, lock);
  const lockBytes = await readWorkerFile(path.join(root, 'lock', 'owner.json'), 65536, { privateMode: true });
  const capturedLock = captureLockOwner(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes)));
  if (!isDeepStrictEqual(capturedLock, lock)) throw refused(new Error('Original admission lock changed.'));
  const stateBytes = await readWorkerFile(path.join(root, 'state.json'), 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes)));
  let expected;
  if (inactive) {
    expected = createWindowsInactiveTaskAdmissionRecord({ observation: retained.observation, lock, state });
  } else if (state.project !== lock.project || state.operationId !== lock.operationId || state.startedAt !== lock.createdAt
    || state.priorRuntime !== 'running' || state.runtimeIdentity !== retained.observation.runtime.generation
    || state.errorCode !== null || state.previousPhase !== null
    || state.phase !== (state.operation === 'restore' ? 'restore-preflight' : 'preflight')) {
    throw refused(new Error('Managed task admission requires matching original preflight state.'));
  }
  await assertLockOwner(root, lock);
  await assertWindowsAdmission(root, admission, { signal });
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const result = await retained.request('capture-admission', signal, {
    control: root, lockSha256: digest(lockBytes), stateSha256: digest(stateBytes),
  });
  if (inactive) {
    const bytes = await readWorkerFile(result.admission, 4194304, { privateMode: true });
    if (digest(bytes) !== result.sha256
      || !isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expected)) {
      throw refused(new Error('Native inactive admission differs from its original stopped binding.'));
    }
  }
  await assertWindowsAdmission(root, admission, { signal });
  if (inactive) {
    retained.publication = Object.freeze({
      control: root, lock, state: Object.freeze({ ...state }), ...result,
      record: expected,
    });
  }
  return result;
}

export async function assertWindowsInactiveTaskAdmissionBinding({
  scope, control, lock: supplied, admission, sha256, signal,
}) {
  signal?.throwIfAborted();
  const retained = inactiveScopes.get(scope);
  const publication = retained?.publication;
  const lock = captureLockOwner(supplied);
  if (!publication || publication.control !== control || !isDeepStrictEqual(publication.lock, lock)
    || publication.admission !== admission || publication.sha256 !== sha256) {
    throw refused(new Error('Original retained inactive admission is required.'));
  }
  await assertLockOwner(control, lock);
  const bytes = await readWorkerFile(admission, 4194304, { privateMode: true });
  if (createHash('sha256').update(bytes).digest('hex') !== sha256
    || !isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), publication.record)) {
    throw refused(new Error('Original inactive admission changed.'));
  }
  await retained.request('check', signal);
  if (!(await readWorkerFile(admission, 4194304, { privateMode: true })).equals(bytes)) {
    throw refused(new Error('Inactive admission changed during native verification.'));
  }
  await assertLockOwner(control, lock);
  signal?.throwIfAborted();
  return Object.freeze({ observation: retained.observation, state: publication.state });
}

export async function captureWindowsInactiveTaskActivationPreparation(options) {
  const { scope, control, signal, state } = options;
  const { observation } = await assertWindowsInactiveTaskAdmissionBinding(options);
  const retained = inactiveScopes.get(scope);
  const statePath = path.join(control, 'state.json');
  const bytes = await readWorkerFile(statePath, 65536, { privateMode: true });
  if (!isDeepStrictEqual(validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), state)) {
    throw refused(new Error('Inactive activation state changed before native preparation.'));
  }
  const stateSha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await retained.request('prepare-inactive-activation', signal, { stateSha256 });
  if (result.file !== path.join(control, 'task-maintenance', 'inactive-activation-prepared.json')
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw refused(new Error('Inactive activation preparation acknowledgement differs.'));
  }
  const record = await readWorkerFile(result.file, 4194304, { privateMode: true });
  const expected = {
    version: 1, kind: 'inactive', phase: 'activation-prepared', operationId: state.operationId,
    admissionSha256: options.sha256, stateSha256,
    sourceCommit: state.sourceCommit, targetCommit: state.targetCommit, backupId: state.backupId,
    taskName: observation.taskName, definition: observation.definition, securityDescriptor: observation.securityDescriptor,
    configuration: path.join(control, `runtime-${state.operationId}`, 'configuration.json'),
    configurationSha256: observation.configurationSha256,
  };
  if (createHash('sha256').update(record).digest('hex') !== result.sha256
    || !isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record)), expected)
    || !(await readWorkerFile(statePath, 65536, { privateMode: true })).equals(bytes)) {
    throw refused(new Error('Native inactive preparation differs from its original admission and state.'));
  }
  await assertWindowsInactiveTaskAdmissionBinding(options);
  retained.activationPreparation = Object.freeze({ ...result, stateSha256 });
  return result;
}

export async function replaceWindowsInactiveTaskBinding(options) {
  const { scope, control, signal } = options;
  const { observation, state } = await assertWindowsInactiveTaskAdmissionBinding(options);
  const retained = inactiveScopes.get(scope);
  const prepared = retained.activationPreparation;
  if (!prepared) throw refused(new Error('Inactive replacement requires original native preparation.'));
  const result = await retained.request('replace-inactive', signal);
  if (result.replaced !== true || result.inhibited !== true
    || typeof result.definition !== 'string' || !result.definition || result.definition.length > 262144
    || result.file !== path.join(control, 'task-maintenance', 'inactive-replacement-complete.json')
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw refused(new Error('Inactive replacement acknowledgement differs.'));
  }
  const bytes = await readWorkerFile(result.file, 4194304, { privateMode: true });
  const requested = await readWorkerFile(
    path.join(control, 'task-maintenance', 'inactive-replacement-requested.json'), 4194304, { privateMode: true });
  const expected = {
    version: 1, kind: 'inactive', phase: 'replacement-complete', operationId: state.operationId,
    preparationSha256: prepared.sha256, previousSha256: createHash('sha256').update(requested).digest('hex'),
    stateSha256: prepared.stateSha256, taskName: observation.taskName, originalDefinition: observation.definition,
    definition: result.definition, securityDescriptor: observation.securityDescriptor,
    configuration: path.join(control, `runtime-${state.operationId}`, 'configuration.json'),
    configurationSha256: observation.configurationSha256,
  };
  if (createHash('sha256').update(bytes).digest('hex') !== result.sha256
    || !isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), expected)) {
    throw refused(new Error('Native inactive replacement differs from its retained preparation.'));
  }
  await assertWindowsInactiveTaskAdmissionBinding(options);
  retained.replacement = result;
  return result;
}

export async function startWindowsInactiveTaskBinding(options) {
  const { scope, control, signal } = options;
  const { observation, state } = await assertWindowsInactiveTaskAdmissionBinding(options);
  const retained = inactiveScopes.get(scope);
  if (!retained.replacement || retained.startupAttempted) {
    throw refused(new Error('Inactive startup requires one original completed replacement.'));
  }
  retained.startupAttempted = true;
  let runtime;
  let result;
  for (const step of ['requested', 'registered', 'enabled', 'started', 'inhibited', 'observed', 'running']) {
    await assertWindowsInactiveTaskAdmissionBinding(options);
    result = await retained.request('start-inactive', signal);
    if (result.step !== step || result.taskName !== observation.taskName
      || result.status !== (step === 'running' ? 'guarded-running' : 'inactive-startup-progress')
      || typeof result.definition !== 'string' || !result.definition || result.definition.length > 262144) {
      throw refused(new Error('Inactive startup acknowledged an unexpected native phase.'));
    }
    if (['observed', 'running'].includes(step)) {
      const captured = captureActivatedRuntime(result.runtime);
      if (captured.identity === observation.retiredRuntime.identity
        || captured.generation === observation.retiredRuntime.generation
        || captured.configurationSha256 !== observation.configurationSha256
        || runtime && !isDeepStrictEqual(captured, runtime)) {
        throw refused(new Error('Inactive startup runtime differs from its admitted new instance.'));
      }
      runtime = Object.freeze(captured);
    } else if (result.runtime !== null) {
      throw refused(new Error('Inactive startup invented readiness before original observation.'));
    }
    await assertWindowsInactiveTaskAdmissionBinding(options);
  }
  const requested = await readWorkerFile(
    path.join(control, 'task-maintenance', 'inactive-start-requested.json'), 4194304, { privateMode: true });
  const running = await readWorkerFile(
    path.join(control, 'task-maintenance', 'inactive-start-running.json'), 4194304, { privateMode: true });
  const expected = {
    version: 1, kind: 'inactive', phase: 'running', operationId: state.operationId,
    preparationSha256: retained.activationPreparation.sha256,
    previousSha256: createHash('sha256').update(requested).digest('hex'),
    stateSha256: retained.activationPreparation.stateSha256,
    controllerPid: scope.identity.pid, controllerIdentity: scope.identity.processIdentity,
    taskName: observation.taskName, definition: result.definition, securityDescriptor: observation.securityDescriptor,
    configuration: path.join(control, `runtime-${state.operationId}`, 'configuration.json'),
    configurationSha256: observation.configurationSha256, runtime,
  };
  if (!isDeepStrictEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(running)), expected)) {
    throw refused(new Error('Native inactive startup receipt differs from its original guarded runtime.'));
  }
  await assertWindowsInactiveTaskAdmissionBinding(options);
  return Object.freeze({ status: result.status, taskName: result.taskName, runtime });
}
