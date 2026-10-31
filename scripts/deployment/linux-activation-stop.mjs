import { link, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { linuxNative } from './linux-systemd.mjs';
import { syncWorkerDirectory } from './worker-files.mjs';

// The live activation authority supplies the retained generation, inhibitor and journal.
export async function stopLinuxActivation({ active, held, inhibition, checkHeld, record, checkAuthority }) {
  await checkAuthority();
  await checkHeld();
  await active.check();
  const parent = path.dirname(inhibition);
  const original = await lstat(parent);
  const checkParent = async () => {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022
      || info.dev !== original.dev || info.ino !== original.ino) throw new Error('Activation inhibitor directory changed.');
  };
  await checkParent();
  await record('activation-stop-intent', active.identity);
  await checkHeld();
  await active.check();
  await checkParent();
  await link(held, inhibition);
  await syncWorkerDirectory(parent);
  await checkHeld(true);
  await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
  await checkHeld(true);
  await active.checkInhibited();
  await record('activation-stop-inhibited', active.identity);
  await record('activation-stop-requested', active.identity);
  await checkHeld(true);
  await active.checkInhibited();
  await linuxNative('/usr/bin/systemctl', ['--system', 'stop', '--no-block', active.identity.runtime.unit]);
  const checkStopped = async () => {
    await checkAuthority();
    await checkParent();
    await checkHeld(true);
    if (!(await active.checkInhibited({ stopped: true })).stopped) throw new Error('Activated service generation is not stopped.');
    await checkHeld(true);
    return Object.freeze({ stopped: true, inhibited: true });
  };
  const deadline = performance.now() + 60000;
  while (performance.now() < deadline) {
    await checkAuthority();
    await checkParent();
    await checkHeld(true);
    if ((await active.checkInhibited({ stopped: true })).stopped) {
      await checkStopped();
      await record('activation-stopped', active.identity);
      return checkStopped;
    }
    await delay(50);
  }
  throw new Error('Activated service domain did not stop within its observation budget.');
}
