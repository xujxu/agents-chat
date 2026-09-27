import { randomBytes } from 'node:crypto';
import { open, readFile, readlink, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureOwner, captureWorkerFields, captureLinuxAccount } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';
import { captureWorkerCommand, workerWire } from './worker-wire.mjs';
import { linuxNative as native, linuxSystemdProperties } from './linux-systemd.mjs';

const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
function diagnosticTail(base64) {
  const bytes = Buffer.from(Buffer.from(base64, 'base64').toString('utf8'));
  let start = Math.max(0, bytes.length - 8192);
  // Replacement decoding can expand binary input; trim again on a UTF-8 boundary.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

const properties = unit => linuxSystemdProperties(unit,
  ['InvocationID', 'ControlGroup', 'ActiveState', 'SubState', 'Result', 'MainPID', 'LoadState']);

export async function prepareLinuxWorker({ owner: suppliedOwner, saved, command: suppliedCommand, uid, gid, signal }) {
  const owner = captureOwner(suppliedOwner);
  const command = captureWorkerCommand(suppliedCommand);
  const account = captureLinuxAccount({ uid, gid });
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('Native Linux worker manager requires a root controller and explicit target uid/gid.');
  }
  signal?.throwIfAborted();
  if (await processIdentity(process.pid) !== owner.controllerIdentity) throw new Error('Controller identity changed.');
  if ((await readFile('/proc/1/comm', 'utf8')).trim() !== 'systemd') throw new Error('System manager is not systemd.');
  await readFile('/sys/fs/cgroup/cgroup.controllers');
  const control = path.dirname(saved.directory);
  const verified = await verifyWorkerEngine({
    control, project: owner.project, operationId: owner.operationId, manifestSha256: saved.manifestSha256,
  });
  if (verified.directory !== saved.directory) throw new Error('Saved engine identity changed.');
  const unit = `agents-deploy-${owner.workerId}.service`;
  if ((await properties(unit)).LoadState !== 'not-found') throw new Error('Native worker unit already exists.');
  const socketPath = path.join(control, `w-${owner.workerId}.sock`);
  if (Buffer.byteLength(socketPath) > 103) throw new Error('Native worker control socket path is too long.');
  const token = randomBytes(32).toString('hex');
  const boot = await bootId();
  let socket;
  let events;
  let groupDirectory;
  let identity;
  let closed = false;
  let granted = false;
  let creationAttempted = false;
  let closeServer;
  const connected = Promise.withResolvers();
  // Retain failures until awaited; a native process can connect while systemd-run is returning.
  connected.promise.catch(() => {});
  const server = createServer(candidate => {
    if (socket || closed) { candidate.destroy(); return; }
    socket = candidate;
    connected.resolve(workerWire(socket));
  });
  server.on('error', error => connected.reject(error));
  const closeTransport = () => {
    closed = true;
    socket?.destroy();
    closeServer ??= new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    });
    return closeServer;
  };
  const matching = async () => {
    const state = await properties(unit);
    if (!identity || await bootId() !== identity.bootId || state.InvocationID !== identity.invocationId
      || (state.ControlGroup && state.ControlGroup !== identity.controlGroup)) {
      throw new Error('Original native worker domain identity is unavailable or replaced.');
    }
    return state;
  };
  const populated = async () => {
    const buffer = Buffer.alloc(4096);
    let bytesRead;
    try { ({ bytesRead } = await events.read(buffer, 0, buffer.length, 0)); }
    catch (error) {
      // Kernel cgroup_destroy_locked forbids removal of populated/live-child groups.
      // Only the retained original directory's deletion, not a missing path, proves retirement.
      if (error.code !== 'ENODEV'
        || await readlink(`/proc/self/fd/${groupDirectory.fd}`)
          !== `/sys/fs/cgroup${identity.controlGroup} (deleted)`) throw error;
      await matching();
      return false;
    }
    const values = buffer.subarray(0, bytesRead).toString('utf8').match(/^populated ([01])$/m);
    if (!values) throw new Error('Original cgroup population cannot be read.');
    return values[1] === '1';
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    signal?.throwIfAborted();
    creationAttempted = true;
    await native('/usr/bin/systemd-run', [
      '--system', '--quiet', '--unit', unit,
      '--property=Type=exec', '--property=RemainAfterExit=yes', '--property=Restart=no',
      '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
      '--property=TimeoutStartSec=15s', '--property=TimeoutStopSec=10s', '--property=RuntimeMaxSec=1800s',
      '--property=User=0', '--property=Group=0', '--property=UnsetEnvironment=NODE_OPTIONS NODE_PATH',
      '--property=NoNewPrivileges=yes',
      '--', process.execPath, path.join(saved.directory, 'linux-worker-bootstrap.mjs'),
      socketPath, token, String(process.pid), owner.controllerIdentity,
    ]);
    let timer;
    const wire = await Promise.race([
      connected.promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native bootstrap connection timed out.')), 30000);
      }),
    ]).finally(() => clearTimeout(timer));
    const ready = captureWorkerFields(await wire.receive(), [
      'type', 'token', 'pid', 'processIdentity', 'controlGroup',
    ], 'native readiness');
    const state = await properties(unit);
    if (ready.type !== 'ready' || ready.token !== token || !Number.isSafeInteger(ready.pid)
      || String(ready.pid) !== state.MainPID || !/^[a-f0-9]{32}$/.test(state.InvocationID)
      || state.ControlGroup !== `/system.slice/${unit}` || ready.controlGroup !== state.ControlGroup
      || await processIdentity(ready.pid) !== ready.processIdentity || await bootId() !== boot) {
      throw new Error('Native bootstrap placement identity mismatch.');
    }
    identity = Object.freeze({
      kind: 'systemd', bootId: boot, manager: 'system', unit,
      invocationId: state.InvocationID, controlGroup: state.ControlGroup,
    });
    if ((await statfs(`/sys/fs/cgroup${identity.controlGroup}`)).type !== 0x63677270) {
      throw new Error('Worker domain is not a cgroup-v2 filesystem.');
    }
    groupDirectory = await open(`/sys/fs/cgroup${identity.controlGroup}`, 'r');
    events = await open(`/sys/fs/cgroup${identity.controlGroup}/cgroup.events`, 'r');
    if (!await populated()) throw new Error('Native bootstrap domain unexpectedly empty.');
    return {
      identity,
      async run({ signal: runSignal }) {
        runSignal.throwIfAborted();
        if (closed || granted) throw new Error('Native command admission is closed.');
        granted = true;
        await wire.send({ type: 'run', command, account });
        const result = captureWorkerFields(await wire.receive({ signal: runSignal, timeoutMs: 1800000 }),
          ['type', 'exitCode', 'signal', 'stdout', 'stderr'], 'native result');
        if (result.type !== 'result' || (result.exitCode !== null && !Number.isInteger(result.exitCode))
          || (result.signal !== null && typeof result.signal !== 'string')
          || ![result.stdout, result.stderr].every(value => typeof value === 'string'
            && value.length <= 10924 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))) {
          throw new Error('Malformed native worker result.');
        }
        const output = {
          exitCode: result.exitCode, signal: result.signal,
          stdout: diagnosticTail(result.stdout),
          stderr: diagnosticTail(result.stderr),
        };
        if (result.exitCode !== 0 || result.signal !== null) {
          throw Object.assign(new Error('Native deployment command failed.'), {
            code: 'DEPLOYMENT_COMMAND_FAILED', result: output,
          });
        }
        return output;
      },
      closeAdmission: closeTransport,
      async stop() {
        await matching();
        if (await populated()) {
          await native('/usr/bin/systemctl', ['--system', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit]);
        }
      },
      async join() {
        await closeTransport();
        for (let index = 0; index < 200; index++) {
          if (!await populated()) return;
          await delay(50);
        }
        throw new Error('Native worker group did not become empty.');
      },
      async observe() {
        await matching();
        return { identity, empty: !await populated() };
      },
      async retire() {
        const state = await matching();
        if (await populated()) throw new Error('Cannot retire a populated worker.');
        await events.close();
        events = undefined;
        await groupDirectory.close();
        groupDirectory = undefined;
        if (state.ActiveState === 'failed') await native('/usr/bin/systemctl', ['--system', 'reset-failed', unit]);
        else await native('/usr/bin/systemctl', ['--system', 'stop', unit]);
      },
    };
  } catch (error) {
    const errors = [error];
    try { await closeTransport(); }
    catch (failure) { errors.push(failure); }
    if (events) {
      try { await events.close(); }
      catch (failure) { errors.push(failure); }
    }
    if (groupDirectory) {
      try { await groupDirectory.close(); }
      catch (failure) { errors.push(failure); }
    }
    if (creationAttempted) {
      throw Object.assign(new Error('Native preparation is uncertain; retain the unit and operation evidence.', {
        cause: errors.length === 1 ? error : new AggregateError(errors),
      }), { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
    }
    throw errors.length === 1 ? error : new AggregateError(errors);
  }
}
