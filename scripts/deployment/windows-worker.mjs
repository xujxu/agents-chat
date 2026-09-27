import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { captureOwner, captureDomain, captureWorkerFields } from './worker-identity.mjs';
import { captureWorkerCommand, workerWire } from './worker-wire.mjs';
import { processIdentity } from './process-identity.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';

function uncertain(cause) {
  return Object.assign(new Error('Windows Job owner authority is uncertain; retain lock and evidence.', { cause }),
    { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
}
function tail(base64) {
  if (typeof base64 !== 'string' || base64.length > 10924
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('Invalid Windows worker output.');
  }
  const bytes = Buffer.from(Buffer.from(base64, 'base64').toString('utf8'));
  let start = Math.max(0, bytes.length - 8192);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function cancellable(promise, signal) {
  let cancel;
  try {
    signal.throwIfAborted();
    return await Promise.race([promise, new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}

export async function prepareWindowsWorker({
  owner: suppliedOwner, saved, command: suppliedCommand, pwsh, accountSid, sessionId, signal,
}) {
  const owner = captureOwner(suppliedOwner);
  const command = captureWorkerCommand(suppliedCommand);
  if (process.platform !== 'win32' || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
    || typeof accountSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(accountSid)
    || !Number.isSafeInteger(sessionId) || sessionId < 0) {
    throw new Error('Explicit Windows runtime, account and session are required.');
  }
  signal?.throwIfAborted();
  if (await processIdentity(process.pid) !== owner.controllerIdentity) throw new Error('Controller identity changed.');
  const verified = await verifyWorkerEngine({
    control: path.dirname(saved.directory), project: owner.project,
    operationId: owner.operationId, manifestSha256: saved.manifestSha256,
  });
  if (verified.directory !== saved.directory) throw new Error('Saved engine identity changed.');
  signal?.throwIfAborted();
  const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File',
    path.join(saved.directory, 'windows-worker-owner.ps1'), '-ControllerPid', String(process.pid),
    '-ControllerIdentity', owner.controllerIdentity, '-Generation', owner.workerId,
    '-AccountSid', accountSid, '-SessionId', String(sessionId),
  ], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  });
  let stderr = Buffer.alloc(0);
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, bytes]).subarray(-8192); });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    child.once('error', reject);
  });
  exited.catch(() => {});
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.once('error', error => transport.destroy(error));
  child.once('close', () => transport.destroy());
  const wire = workerWire(transport);
  try {
    const ready = captureWorkerFields(await wire.receive({ timeoutMs: 60000 }),
      ['type', 'identity', 'pid', 'processIdentity'], 'Windows owner readiness');
    const identity = captureDomain(ready.identity, owner);
    if (ready.type !== 'ready' || ready.pid !== child.pid || identity.accountSid !== accountSid
      || identity.sessionId !== sessionId || await processIdentity(child.pid) !== ready.processIdentity) {
      throw new Error('Windows original owner identity mismatch.');
    }
    let closed = false;
    let granted = false;
    let sequence = 0;
    let failure;
    const pending = new Map();
    const fail = error => {
      failure ??= uncertain(error);
      for (const reply of pending.values()) reply.reject(failure);
      pending.clear();
      wire.close();
    };
    const receiver = (async () => {
      while (true) {
        const frame = captureWorkerFields(await wire.receive({ timeoutMs: 1800000 }),
          ['id', 'type', 'value'], 'Windows owner reply');
        const reply = pending.get(frame.id);
        if (frame.type !== 'reply' || !reply) throw new Error('Unsolicited Windows owner reply.');
        pending.delete(frame.id);
        reply.resolve(frame.value);
      }
    })().catch(fail);
    const rpc = async (method, extra = {}) => {
      if (failure) throw failure;
      if (pending.size >= 8) throw uncertain(new Error('Too many native owner requests.'));
      const id = ++sequence;
      const reply = Promise.withResolvers();
      pending.set(id, reply);
      reply.promise.catch(() => {});
      try {
        await wire.send({ id, method, ...extra });
        const value = await bounded(reply.promise, method === 'run' ? 1800000 : 30000, `Windows ${method}`);
        if (!['run', 'observe'].includes(method) && value !== null) throw new Error('Invalid cleanup acknowledgement.');
        return value;
      } catch (error) {
        fail(error);
        throw failure;
      }
    };
    return {
      identity,
      async run({ signal: runSignal }) {
        runSignal.throwIfAborted();
        if (closed || granted) throw new Error('Windows command admission is closed.');
        granted = true;
        const value = await cancellable(rpc('run', { command }), runSignal);
        const result = captureWorkerFields(value, ['type', 'exitCode', 'stdout', 'stderr'], 'Windows command result');
        if (result.type !== 'result' || !Number.isInteger(result.exitCode)) throw new Error('Invalid native exit result.');
        const output = { exitCode: result.exitCode, signal: null, stdout: tail(result.stdout), stderr: tail(result.stderr) };
        if (result.exitCode !== 0) throw Object.assign(new Error('Windows deployment command failed.'),
          { code: 'DEPLOYMENT_COMMAND_FAILED', result: output });
        return output;
      },
      async closeAdmission() { closed = true; await rpc('closeAdmission'); },
      async stop() { await rpc('stop'); },
      async join() { await rpc('join'); },
      async observe() { return rpc('observe'); },
      async retire() {
        await rpc('retire');
        const result = await bounded(exited, 15000, 'Windows owner retirement');
        if (result.code !== 0 || result.signal !== null) throw uncertain(new Error('Native owner retirement failed.'));
        wire.close();
        await receiver;
      },
    };
  } catch (error) {
    wire.close();
    const errors = [error];
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try { await bounded(exited, 15000, 'Failed Windows owner cleanup'); }
    catch (cleanup) { errors.push(cleanup); }
    throw Object.assign(uncertain(errors.length === 1 ? errors[0] : new AggregateError(errors)),
      { stderr: stderr.toString('utf8') });
  }
}
