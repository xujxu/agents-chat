import { constants } from 'node:fs';
import { lstat, mkdir, open, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { createEvidenceJournal } from './evidence-journal.mjs';
import { canonicalWorkerDirectory, syncWorkerDirectory } from './worker-files.mjs';
import { linuxNative, linuxSystemdProperties } from './linux-systemd.mjs';

// Linux O_PATH retains the symlink itself with O_NOFOLLOW, preventing inode reuse.
const pathOnly = 0x200000;
const directoryIdentity = info => ({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode });
const linkIdentity = info => Object.fromEntries([
  'dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs',
].map(name => [name, String(info[name])]));
const phases = ['intent', 'linked', 'enabled'];

export async function enableLinuxFirstUnit({ publication, control, lock: supplied, signal }) {
  const lock = captureLockOwner(supplied);
  const { project, unit } = publication.identity;
  if (process.platform !== 'linux' || process.getuid() !== 0 || publication.status !== 'configured-inhibited'
    || typeof publication.check !== 'function' || project !== lock.project
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('First-unit enablement requires its original inhibited publication and deployment owner.');
  }
  const state = await loadState(control);
  if (state?.project !== project || state.operationId !== lock.operationId || state.operation !== 'deploy'
    || state.priorRuntime !== 'absent' || state.phase !== 'configuring' || state.backupId !== null
    || !state.targetCommit || state.errorCode !== null) {
    throw new Error('First-unit enablement requires matching fresh configuring-phase admission.');
  }
  const binding = Object.fromEntries(Object.entries(state)
    .filter(([name]) => !['phase', 'previousPhase', 'updatedAt', 'errorCode'].includes(name)));
  const root = '/etc/systemd/system';
  const parent = path.join(root, 'multi-user.target.wants');
  const startupLink = path.join(parent, unit);
  const target = path.join(root, unit);
  let parentInfo;
  let journal;
  let linkHandle;
  let originalLink;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([linkHandle?.close(), journal?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'First-unit enablement cleanup failed; retain evidence.');
  };
  try {
    const rootInfo = (await canonicalWorkerDirectory(root)).info;
    const checkDirectory = async (directory, expected) => {
      const { info } = await canonicalWorkerDirectory(directory);
      if (info.uid !== 0 || info.mode & 0o022 || !same(directoryIdentity(info), directoryIdentity(expected))) {
        throw new Error('First-unit enablement directory changed or has unsafe ownership.');
      }
    };
    try { parentInfo = (await canonicalWorkerDirectory(parent)).info; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const checkFiles = async ({ signal: checkSignal } = {}) => {
      checkSignal?.throwIfAborted();
      if (closed) throw new Error('First-unit enablement authority is closed.');
      await assertLockOwner(control, lock);
      const current = await loadState(control);
      if (!current || Object.entries(binding).some(([name, value]) => current[name] !== value)) {
        throw new Error('First-unit enablement operation identity changed.');
      }
      await checkDirectory(root, rootInfo);
      if (parentInfo) await checkDirectory(parent, parentInfo);
      if (originalLink) {
        const named = await lstat(startupLink, { bigint: true });
        const retained = await linkHandle.stat({ bigint: true });
        if (!named.isSymbolicLink() || named.uid !== 0n || named.nlink !== 1n || retained.nlink !== 1n
          || !same(linkIdentity(named), originalLink) || !same(linkIdentity(retained), originalLink)
          || await readlink(startupLink) !== target
          || !same(linkIdentity(await lstat(startupLink, { bigint: true })), originalLink)) {
          throw new Error('Original first-unit startup link changed or was replaced.');
        }
      }
      await journal?.check();
      checkSignal?.throwIfAborted();
    };
    const check = async () => {
      await checkFiles({ signal });
      if (!same(await loadState(control), state)) throw new Error('First-unit configuring state changed during enablement.');
      await publication.check();
      signal?.throwIfAborted();
    };
    await check();
    try {
      await lstat(startupLink);
      throw new Error('Existing first-unit startup link requires inspection, not replacement.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const base = { version: 1, lock, project, unit, startupLink, target };
    const entry = () => originalLink && { parent: directoryIdentity(parentInfo), link: originalLink };
    journal = await createEvidenceJournal({
      root: control, project, name: 'service-enablement.ndjson', maximumBytes: 65536, maximumRecords: 3,
      validate(value, records) {
        const { phase, identity, ...rest } = value;
        if (!same(rest, base) || phase !== phases[records.length]
          || !same(identity, records.length === 0 ? null : entry())) {
          throw new Error('Invalid first-unit enablement receipt.');
        }
        return Object.freeze(value);
      },
    });
    const record = async phase => {
      await check();
      await journal.record({ ...base, phase, identity: entry() ?? null });
    };
    await record('intent');
    if (!parentInfo) {
      await check();
      await mkdir(parent, { mode: 0o755 });
      parentInfo = (await canonicalWorkerDirectory(parent)).info;
      await syncWorkerDirectory(root);
    }
    await check();
    await symlink(target, startupLink);
    const named = await lstat(startupLink, { bigint: true });
    linkHandle = await open(startupLink, pathOnly | constants.O_NOFOLLOW);
    originalLink = linkIdentity(named);
    await syncWorkerDirectory(parent);
    await record('linked');
    await check();
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
    if ((await linuxSystemdProperties(unit, ['UnitFileState'])).UnitFileState !== 'enabled') {
      throw new Error('First unit did not acquire persistent systemd enablement.');
    }
    await record('enabled');
    return Object.freeze({
      status: 'enabled-inhibited', identity: structuredClone({ unit, startupLink, target, ...entry() }),
      check, checkFiles, close,
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First-unit enablement failed; retain all evidence.'); }
    throw error;
  }
}
