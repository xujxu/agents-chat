import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { workerWire } from './worker-wire.mjs';

export function windowsControllerTransport({ pwsh, args, refused, label }) {
  const child = spawn(pwsh, args, {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  });
  let stderr = Buffer.alloc(0);
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, bytes]).subarray(-4096); });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  exited.catch(() => {});
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.once('error', error => transport.destroy(error));
  child.once('close', () => transport.destroy());
  const wire = workerWire(transport);
  let failure;
  const waitForExit = async () => {
    let timer;
    try {
      return await Promise.race([exited, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not exit.`)), 15000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return {
    child, wire, waitForExit,
    async abandon(cause) {
      failure ??= refused(cause);
      wire.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      try { await waitForExit(); }
      catch (cleanup) { failure = refused(new AggregateError([failure, cleanup])); }
      failure.diagnostic = stderr.toString('utf8');
      return failure;
    },
  };
}
