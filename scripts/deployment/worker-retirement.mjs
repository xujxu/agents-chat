import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertLockOwner, loadState } from './state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';
import { readWorkerJournal } from './worker-journal.mjs';
import { journalUncertain } from './evidence-journal.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fileIdentity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const markerName = 'worker-retirement.json';

// Called only by the original sealed live operation; never reopens interrupted authority.
export async function retireWorkerEvidence({ control, lock, saved, workers, closeAuthority }) {
  const handles = [];
  const errors = [];
  let marker;
  let root;
  let controlInfo;
  let lockInfo;
  let lockFile;
  let stateFile;
  let checkFile;
  let checkAuthority;
  try {
    ({ root, info: controlInfo } = await canonicalWorkerDirectory(control, { privateMode: true }));
    ({ info: lockInfo } = await canonicalWorkerDirectory(path.join(root, 'lock'), { privateMode: true }));
    await assertLockOwner(root, lock);
    const state = await loadState(root);
    if (!state || state.operationId !== lock.operationId || state.project !== lock.project
      || !['accepted', 'restored'].includes(state.phase)) {
      throw new Error('Worker retirement requires matching application acceptance.');
    }
    const verified = await verifyWorkerEngine({
      control: root, project: lock.project, operationId: lock.operationId, manifestSha256: saved.manifestSha256,
    });
    if (!same(saved, verified)) throw new Error('Retirement helper identity changed.');
    const engineInfo = (await canonicalWorkerDirectory(saved.directory, { privateMode: true })).info;
    const capture = async relative => {
      const file = path.join(root, relative);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      handles.push(handle);
      const info = await handle.stat({ bigint: true });
      const bytes = await readWorkerFile(file, 1024 * 1024, { privateMode: true });
      const named = await lstat(file, { bigint: true });
      if (!same(fileIdentity(info), fileIdentity(named)) || info.nlink !== 1n) {
        throw new Error('Retirement file identity changed.');
      }
      return { path: relative, ...fileIdentity(info), bytes: bytes.length, sha256: digest(bytes) };
    };
    checkFile = async entry => {
      const file = path.join(root, entry.path);
      const info = await lstat(file, { bigint: true });
      if (!same(fileIdentity(info), { dev: entry.dev, ino: entry.ino })) {
        throw new Error('Original retirement file was replaced.');
      }
      const bytes = await readWorkerFile(file, 1024 * 1024, { privateMode: true });
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
        throw new Error('Retirement file content changed.');
      }
    };
    lockFile = await capture(path.join('lock', 'owner.json'));
    stateFile = await capture('state.json');
    const entries = [];
    for (const owner of workers) {
      if ((await readWorkerJournal(root, owner)).at(-1).phase !== 'settled') {
        throw new Error('Cannot retire an unsettled worker.');
      }
      entries.push(await capture(`worker-${owner.workerId}.ndjson`));
    }
    const engineNames = (await readdir(saved.directory)).sort();
    for (const name of engineNames) entries.push(await capture(path.join('worker-engine', name)));
    entries.push(await capture('worker-operation.ndjson'));
    const remaining = new Map(entries.map(entry => [entry.path, entry]));
    let engineRemoved = false;
    checkAuthority = async () => {
      const current = await canonicalWorkerDirectory(root, { privateMode: true });
      const currentLock = await canonicalWorkerDirectory(path.join(root, 'lock'), { privateMode: true });
      if (!same(fileIdentity(current.info), fileIdentity(controlInfo))
        || !same(fileIdentity(currentLock.info), fileIdentity(lockInfo))) {
        throw new Error('Retirement authority directory was replaced.');
      }
      await assertLockOwner(root, lock);
      await checkFile(lockFile);
      await checkFile(stateFile);
      if (!same(await loadState(root), state)) throw new Error('Application acceptance changed during retirement.');
      if (marker) await checkFile(marker);
    };
    const checkInventory = async () => {
      await checkAuthority();
      const expected = [...remaining.keys()].filter(file => !file.startsWith(`worker-engine${path.sep}`));
      if (!engineRemoved) expected.push('worker-engine');
      if (marker) expected.push(markerName);
      const actual = (await readdir(root)).filter(file => file.startsWith('worker-')).sort();
      if (!same(actual, expected.sort())) throw new Error('Unexpected retirement evidence inventory.');
      if (!engineRemoved) {
        const current = await canonicalWorkerDirectory(saved.directory, { privateMode: true });
        if (!same(fileIdentity(current.info), fileIdentity(engineInfo))) throw new Error('Helper directory was replaced.');
        const expectedEngine = [...remaining.keys()].filter(file => file.startsWith(`worker-engine${path.sep}`))
          .map(file => path.basename(file)).sort();
        if (!same((await readdir(saved.directory)).sort(), expectedEngine)) {
          throw new Error('Helper deletion inventory changed.');
        }
      }
    };
    await checkInventory();
    await writeWorkerFile(path.join(root, markerName), Buffer.from(`${JSON.stringify({
      version: 2, lock, manifestSha256: saved.manifestSha256, state: stateFile, files: entries,
      lockFile, controlIdentity: fileIdentity(controlInfo), lockIdentity: fileIdentity(lockInfo),
      engineIdentity: fileIdentity(engineInfo),
    })}\n`));
    await syncWorkerDirectory(root);
    marker = await capture(markerName);
    await closeAuthority();
    for (const entry of entries) {
      await checkInventory();
      await checkFile(entry);
      await unlink(path.join(root, entry.path));
      remaining.delete(entry.path);
      await syncWorkerDirectory(path.dirname(path.join(root, entry.path)));
      if (!engineRemoved && entry.path.startsWith(`worker-engine${path.sep}`)
        && ![...remaining.keys()].some(file => file.startsWith(`worker-engine${path.sep}`))) {
        await checkInventory();
        await rmdir(saved.directory);
        engineRemoved = true;
        await syncWorkerDirectory(root);
      }
    }
    await checkInventory();
  } catch (error) { errors.push(error); }
  for (const handle of handles) {
    try { await handle.close(); }
    catch (error) { errors.push(error); }
  }
  if (!errors.length) {
    try {
      await checkAuthority();
      await unlink(path.join(root, markerName));
      await syncWorkerDirectory(root);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw journalUncertain(errors.length === 1 ? errors[0] : new AggregateError(errors));
}
