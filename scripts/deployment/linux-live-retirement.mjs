import { createHash } from 'node:crypto';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, loadState } from './state.mjs';
import { acquireRecoveryAdmission } from './linux-recovery-admission.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { retainLinuxStartupLink } from './linux-startup-link.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function releaseLiveRetirement(control, owner) {
  const admission = await acquireRecoveryAdmission(control);
  let service;
  let startup;
  try {
    await assertLockOwner(control, owner);
    const file = path.join(control, 'live-retirement.json');
    const bytes = await readWorkerFile(file, 1024 * 1024, { privateMode: true });
    const originalFile = identity(await lstat(file));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (![3, 4].includes(value.version) || !same(value.lock, owner)
      || !['accepted', 'prior-runtime-restored', ...(value.state?.operation === 'restore' ? ['restored'] : [])].includes(value.state?.phase)
      || !same(await loadState(control), value.state)) throw new Error('Live retirement does not authorize this unlock.');
    if (value.version === 4) {
      if (value.state.operation !== 'deploy' || value.state.priorRuntime !== 'absent'
        || value.state.phase !== 'accepted' || !value.workers) {
        throw new Error('First live retirement requires accepted fresh deployment and worker evidence.');
      }
      startup = await retainLinuxStartupLink({ unit: value.runtime.runtime.unit, expected: value.startup });
      const held = `/etc/systemd/system/${value.runtime.runtime.unit}.d/90-agents-chat-deployment.conf.${owner.token}.held`;
      const files = [held, ...['service-activation.ndjson', 'service-install.ndjson', 'service-enablement.ndjson']
        .map(name => path.join(control, name))];
      if (!Array.isArray(value.files) || !same(value.files.map(entry => entry?.file), files)) {
        throw new Error('First live retirement inventory changed.');
      }
    }
    service = await inspectLinuxService({ unit: value.runtime.runtime.unit, project: owner.project,
      npm: value.runtime.executables[0].file, node: value.runtime.executables[1].file });
    if (!same(service.identity, value.runtime)) throw new Error('Live retired service generation changed.');
    const checkFile = async (entry, expected) => {
      if (entry.file !== expected || !same(identity(await lstat(expected)), { dev: entry.dev, ino: entry.ino })) {
        throw new Error('Live retirement authority file replaced.');
      }
      const content = await readWorkerFile(expected, 1024 * 1024, { privateMode: true });
      if (content.length !== entry.bytes || digest(content) !== entry.sha256) throw new Error('Live retirement authority changed.');
    };
    const lock = path.join(control, 'lock');
    const check = async () => {
      await admission.check();
      await service.check();
      await startup?.check();
      if (value.version === 4) {
        await checkFile(value.deploymentFile, path.join(control, 'deployment.json'));
        for (const entry of value.files) {
          try { await lstat(entry.file); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          throw new Error('First retirement evidence reappeared before live unlock.');
        }
      }
      if (!same(identity(await lstat(file)), originalFile)
        || !(await readWorkerFile(file, 1024 * 1024, { privateMode: true })).equals(bytes)) {
        throw new Error('Live retirement handoff changed.');
      }
      const root = await canonicalWorkerDirectory(control, { privateMode: true });
      if (!same(identity(root.info), value.controlIdentity)) throw new Error('Live retirement directory changed.');
      await checkFile(value.stateFile, path.join(control, 'state.json'));
      if ((await readdir(control)).some(name => name.startsWith('service-') || name.startsWith('worker-')
        || name === 'recovery-lock')) throw new Error('Service/worker/recovery evidence still prevents live unlock.');
    };
    await check();
    await assertLockOwner(control, owner);
    if (!same(identity((await canonicalWorkerDirectory(lock, { privateMode: true })).info), value.lockIdentity)
      || !same((await readdir(lock)).sort(), ['owner.json'])) throw new Error('Original live lock directory changed.');
    await checkFile(value.lockFile, path.join(lock, 'owner.json'));
    await unlink(path.join(lock, 'owner.json'));
    await syncWorkerDirectory(lock);
    await check();
    if (!same(identity((await canonicalWorkerDirectory(lock, { privateMode: true })).info), value.lockIdentity)) {
      throw new Error('Original live lock directory replaced during unlock.');
    }
    await rmdir(lock);
    await syncWorkerDirectory(control);
    await check();
    await unlink(file);
    await syncWorkerDirectory(control);
  } finally {
    try {
      const results = await Promise.allSettled([service?.close(), startup?.close()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Live retirement authority cleanup failed.');
    }
    finally { await admission.close(); }
  }
}
