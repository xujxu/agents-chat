import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { canonicalWorkerDirectory } from './worker-files.mjs';

export async function acquireRecoveryAdmission(control) {
  if (process.platform !== 'linux') throw new Error('Native recovery admission requires Linux.');
  const initial = await canonicalWorkerDirectory(control, { privateMode: true });
  const handle = await open(initial.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let closed = false;
  const check = async () => {
    if (closed) throw new Error('Recovery admission is closed.');
    const current = await canonicalWorkerDirectory(control, { privateMode: true });
    const retained = await handle.stat();
    if (current.info.dev !== initial.info.dev || current.info.ino !== initial.info.ino
      || retained.dev !== initial.info.dev || retained.ino !== initial.info.ino) {
      throw new Error('Recovery admission control directory was replaced.');
    }
  };
  const close = async () => {
    if (!closed) {
      await handle.close();
      closed = true;
    }
  };
  try {
    await check();
    // flock and the controller share this open-file description, not a pathname lock.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error('Another controller holds recovery admission, or native locking failed.'));
      });
    });
    await check();
    return { check, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Recovery admission cleanup failed.'); }
    throw error;
  }
}
