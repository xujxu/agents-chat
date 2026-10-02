import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerWire } from './worker-wire.mjs';

const script = fileURLToPath(new URL('./windows-task-controller.ps1', import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function uncertain(cause) {
  return Object.assign(new Error('Windows task maintenance authority is uncertain; retain inhibition and evidence.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED', recoveryAllowed: false,
  });
}
async function boundedExit(exited) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native task controller did not exit.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

function captureActivatedRuntime(value) {
  const runtime = captureWorkerFields(value, ['pid', 'identity', 'generation', 'instanceGuid', 'sessionId',
    'configurationSha256', 'launcherPid', 'readySha256'], 'activated runtime');
  if (![runtime.pid, runtime.launcherPid].every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)
    || !Number.isSafeInteger(runtime.sessionId) || runtime.sessionId < 0 || runtime.sessionId > 2147483647
    || typeof runtime.identity !== 'string' || runtime.identity.length > 64
    || !new RegExp(`^${runtime.pid}:[1-9][0-9]*$`).test(runtime.identity)
    || ![runtime.generation, runtime.instanceGuid].every(id => typeof id === 'string' && uuid.test(id)
      && id !== '00000000-0000-0000-0000-000000000000')
    || ![runtime.configurationSha256, runtime.readySha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid activated runtime identity.');
  }
  return runtime;
}

function captureTaskListener(value, runtime, port) {
  if (value?.status === 'not-ready') return captureWorkerFields(value, ['status'], 'absent listener');
  const listener = captureWorkerFields(value,
    ['status', 'generation', 'port', 'pid', 'identity', 'address', 'createdAt', 'pairedRecords'], 'retained listener');
  if (listener.status !== 'retained' || listener.generation !== runtime.generation || listener.port !== port
    || !Number.isSafeInteger(listener.pid) || listener.pid < 1 || listener.pid > 2147483647
    || typeof listener.identity !== 'string' || listener.identity.length > 64
    || !new RegExp(`^${listener.pid}:[1-9][0-9]*$`).test(listener.identity)
    || !['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1'].includes(listener.address)
    || typeof listener.createdAt !== 'string' || !/^[1-9][0-9]{0,18}$/.test(listener.createdAt)
    || BigInt(listener.createdAt) > 9223372036854775807n
    || typeof listener.pairedRecords !== 'boolean' || listener.pairedRecords && listener.address !== '::') {
    throw new Error('Original retained Windows listener identity differs.');
  }
  return listener;
}

export async function stopWindowsTask({ pwsh, admission, sha256, signal, transaction }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![pwsh, admission].every(value =>
    typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value))
    || path.basename(admission) !== 'admission.json'
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw uncertain(new Error('Explicit Windows runtime and private admission are required.'));
  }
  const controllerIdentity = await processIdentity(process.pid);
  if (!controllerIdentity) throw uncertain(new Error('Original Node controller identity is unavailable.'));
  let reference;
  if (transaction !== undefined) {
    reference = captureWorkerFields(transaction, ['control', 'lockSha256', 'stateSha256'], 'task transaction reference');
    if (typeof reference.control !== 'string' || !path.isAbsolute(reference.control)
      || /[\0\r\n]/.test(reference.control) || admission !== path.join(reference.control, 'task-maintenance', 'admission.json')
      || ![reference.lockSha256, reference.stateSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
      throw uncertain(new Error('Invalid native task transaction reference.'));
    }
  }
  signal?.throwIfAborted();
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File', script,
    '-Admission', admission, '-Sha256', sha256, '-ControllerPid', String(process.pid),
    '-ControllerIdentity', controllerIdentity,
    ...(reference ? ['-Control', reference.control, '-LockSha256', reference.lockSha256,
      '-StateSha256', reference.stateSha256] : []),
  ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  });
  let stderr = Buffer.alloc(0);
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, bytes]).subarray(-4096); });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    child.once('error', reject);
  });
  exited.catch(() => {});
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.once('error', error => transport.destroy(error));
  child.once('close', () => transport.destroy());
  const wire = workerWire(transport);
  let closed = false;
  let busy = false;
  let sequence = 0;
  let activeRuntime;
  let failure;
  const abandon = async cause => {
    failure ??= uncertain(cause);
    closed = true;
    wire.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try { await boundedExit(exited); }
    catch (cleanup) { failure = uncertain(new AggregateError([failure, cleanup])); }
    failure.diagnostic = stderr.toString('utf8');
    return failure;
  };
  try {
    const ready = captureWorkerFields(await wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'admissionSha256', 'stopped', 'inhibited', 'transactionSha256'], 'task controller readiness');
    if (ready.type !== 'ready' || ready.pid !== child.pid || ready.admissionSha256 !== sha256
      || ready.stopped !== true || ready.inhibited !== true
      || ready.transactionSha256 !== (reference?.lockSha256 ?? null)
      || ready.processIdentity !== await processIdentity(child.pid)) {
      throw new Error('Original native task controller readiness differs.');
    }
    signal?.throwIfAborted();
    const identity = Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity });
    const request = async (method, requestSignal, payload = {}) => {
      if (busy) throw uncertain(new Error('A task controller request is already active.'));
      if (failure) throw failure;
      if (closed) throw uncertain(new Error('Task controller is closed.'));
      busy = true;
      try {
        requestSignal?.throwIfAborted();
        if (method === 'listener' && (!activeRuntime || !Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535)) {
          throw new Error('Listener observation requires active runtime authority and an explicit port.');
        }
        if (method === 'replace' && (typeof payload.configuration !== 'string'
          || !path.isAbsolute(payload.configuration) || /[\0\r\n]/.test(payload.configuration)
          || path.basename(payload.configuration) !== 'configuration.json'
          || typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sha256))) {
          throw new Error('Explicit replacement configuration and digest are required.');
        }
        if (await processIdentity(process.pid) !== controllerIdentity
          || await processIdentity(child.pid) !== identity.processIdentity) {
          throw new Error('Original task controller identity changed.');
        }
        const id = ++sequence;
        const frame = { id, method, ...payload };
        if (Buffer.byteLength(JSON.stringify(frame)) > 4096) throw new Error('Task controller request exceeds its bound.');
        await wire.send(frame);
        const reply = captureWorkerFields(await wire.receive({
          signal: requestSignal, timeoutMs: method === 'activate' ? 90000 : method === 'retire' ? 60000 : 30000,
        }),
          ['id', 'type', 'value', ...(method === 'activate' ? ['runtime'] : method === 'listener' ? ['listener'] : [])], 'task controller reply');
        if (reply.id !== id || reply.type !== 'reply' || reply.value !== method) {
          throw new Error('Unexpected task controller acknowledgement.');
        }
        if (method === 'activate') {
          activeRuntime = captureActivatedRuntime(reply.runtime);
          return activeRuntime;
        }
        if (method === 'listener') return captureTaskListener(reply.listener, activeRuntime, payload.port);
        if (method === 'close') {
          const result = await boundedExit(exited);
          if (result.code !== 0 || result.signal !== null) throw new Error('Native task controller close failed.');
          closed = true;
          wire.close();
        }
      } catch (cause) { throw await abandon(cause); }
      finally { busy = false; }
    };
    return Object.freeze({
      identity,
      check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
      retire: ({ signal: retireSignal } = {}) => request('retire', retireSignal),
      replace: ({ configuration, sha256, signal: replaceSignal } = {}) =>
        request('replace', replaceSignal, { configuration, sha256 }),
      activate: ({ signal: activateSignal } = {}) => request('activate', activateSignal),
      listener: ({ port, signal: listenerSignal } = {}) => request('listener', listenerSignal, { port }),
      async close() {
        if (busy) throw uncertain(new Error('Cannot close an active task controller request.'));
        if (failure) throw failure;
        if (!closed) await request('close');
      },
    });
  } catch (cause) { throw await abandon(cause); }
}
