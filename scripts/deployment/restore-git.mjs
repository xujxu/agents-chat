import { mkdir, lstat, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { gitSourceMetadata, inspectGitDirectory, inspectGitMetadata, readGitMetadataFile, validateGitMetadata } from './git-metadata.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { prepareWindowsGitMetadataSecurity, validateWindowsGitPolicy } from './windows-git-metadata-security.mjs';

const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const maximum = 16 * 1024 * 1024;
const descriptor = value => value === null ? null : {
  dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, gid: value.gid,
  bytes: Buffer.from(value.bytes, 'base64').length, sha256: hash(Buffer.from(value.bytes, 'base64')),
};
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Git lockfiles protect only metadata. The caller must retain stopped application authority.
export async function restoreGitMetadata({ project, backup, record: supplied, checkStopped, signal, pwsh }) {
  const record = validateGitMetadata(supplied, supplied?.commit);
  if (record.version === 2 && !backup) {
    throw new Error('Windows Git metadata restoration requires a private backup for its native security journal adapter.');
  }
  if (typeof checkStopped !== 'function') throw new Error('Git restoration requires stopped runtime authority.');
  const checkAuthority = async () => {
    signal?.throwIfAborted();
    const state = await checkStopped({ signal });
    if (state?.stopped !== true || state.inhibited !== true) throw new Error('Git restoration requires a stopped and inhibited runtime.');
  };
  await checkAuthority();
  const permissions = record.version === 2
    ? await prepareWindowsGitMetadataSecurity({ project, backup, record, signal, pwsh }) : null;
  let failure;
  let result;
  try { result = await restoreGitMetadataCore({ project, record, checkAuthority, signal, permissions }); }
  catch (error) { failure = error; }
  try { await permissions?.close(); }
  catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Git restoration and native cleanup failed.');
    throw error;
  }
  if (failure) throw failure;
  return result;
}

async function restoreGitMetadataCore({ project, record, checkAuthority, signal, permissions }) {
  const { root } = await canonicalWorkerDirectory(project);
  const directory = path.join(root, '.git');
  const git = await inspectGitDirectory(directory);
  const observe = async file => {
    const value = descriptor(await readGitMetadataFile(file, maximum, true));
    return permissions ? permissions.observeFile(file, value) : value;
  };
  const directoryIdentity = async (file, options) => {
    const value = identity((await inspectGitDirectory(file, options)).info);
    return permissions ? permissions.observeDirectory(file, value) : value;
  };
  const collect = async (values, read) => {
    if (!permissions) return Promise.all(values.map(read));
    const results = [];
    for (const value of values) results.push(await read(value));
    return results;
  };
  const guard = path.join(directory, 'agents-chat-restore');
  const proofFile = path.join(guard, 'intent.json');
  const files = [...(record.ref ? [record.ref] : []), 'index', 'HEAD'];
  const contents = [...(record.ref ? [Buffer.from(`${record.commit}\n`)] : []),
    Buffer.from(record.index, 'base64'), Buffer.from(record.head, 'base64')];
  const parents = [...new Set(files.flatMap(file => {
    const parts = file.split('/');
    return parts.slice(0, -1).map((_, index) => path.join(directory, ...parts.slice(0, index + 1)));
  }))];
  let proof;
  let proofBytes;
  let proofIdentity;
  const captureProof = async () => {
    proofBytes = await readWorkerFile(proofFile, 65536, { privateMode: true });
    proofIdentity = identity(await lstat(proofFile, { bigint: true }));
    proof = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proofBytes)),
      ['version', 'project', 'owner', 'recordSha256', 'root', 'guard', 'parents', 'policy', 'entries'], 'Git restore intent');
    if (proof.version !== (permissions ? 2 : 1) || proof.project !== root || proof.recordSha256 !== hash(Buffer.from(JSON.stringify(record)))
      || !Array.isArray(proof.entries) || !same(proof.entries.map(entry => entry?.file), files)
      || !Array.isArray(proof.parents) || !same(proof.parents.map(entry => entry?.file), parents)
      || !Array.isArray(proof.policy) || !same(proof.policy.map(entry => entry?.file), ['config', 'packed-refs'])) {
      throw new Error('Git restore intent does not match the selected saved metadata.');
    }
    captureWorkerFields(proof.owner, ['pid', 'identity'], 'Git restore controller');
    if (!Number.isSafeInteger(proof.owner.pid) || proof.owner.pid < 1 || proof.owner.pid > 2147483647
      || typeof proof.owner.identity !== 'string' || !proof.owner.identity) throw new Error('Invalid Git restore controller.');
    const validateIdentity = value => {
      captureWorkerFields(value, ['dev', 'ino', ...(permissions ? ['windowsSecurity'] : [])], 'Git directory identity');
      if (![value.dev, value.ino].every(number => typeof number === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(number))) {
        throw new Error('Invalid Git directory identity.');
      }
      if (permissions) validateWindowsGitPolicy(value.windowsSecurity, 'directory');
    };
    const validateDescriptor = value => {
      if (value === null) return;
      captureWorkerFields(value, ['dev', 'ino', 'mode', 'uid', 'gid', 'bytes', 'sha256',
        ...(permissions ? ['windowsSecurity'] : [])], 'Git file identity');
      if (![value.dev, value.ino].every(number => typeof number === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(number))) {
        throw new Error('Invalid Git file identity.');
      }
      if (permissions) validateWindowsGitPolicy(value.windowsSecurity, 'file');
      if (!['mode', 'uid', 'gid', 'bytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
        || value.mode > 0o777 || value.bytes > maximum || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
        throw new Error('Invalid Git file descriptor.');
      }
    };
    validateIdentity(proof.root);
    validateIdentity(proof.guard);
    for (const parent of proof.parents) {
      captureWorkerFields(parent, ['file', 'identity'], 'Git restore parent');
      validateIdentity(parent.identity);
    }
    for (const policy of proof.policy) {
      captureWorkerFields(policy, ['file', 'identity'], 'Git restore policy');
      validateDescriptor(policy.identity);
    }
    for (const [index, entry] of proof.entries.entries()) {
      captureWorkerFields(entry, ['file', 'before', 'staged'], 'Git restore entry');
      validateDescriptor(entry.before);
      validateDescriptor(entry.staged);
      if (!entry.staged || entry.staged.bytes !== contents[index].length || entry.staged.sha256 !== hash(contents[index])) {
        throw new Error('Git restore staged identity does not bind the saved bytes.');
      }
    }
    await permissions?.retainProof({ ...proofIdentity, bytes: proofBytes.length, sha256: hash(proofBytes) });
  };
  if (await exists(guard)) {
    await directoryIdentity(guard, { privateMode: true });
    const names = await readdir(guard);
    if (names.length) {
      if (!same(names, ['intent.json'])) throw new Error('Git restoration contains incomplete or foreign evidence.');
      await captureProof();
    }
  }
  if (!proof) {
    const current = await inspectGitMetadata({ project: root, signal });
    const owner = { pid: process.pid, identity: await processIdentity(process.pid) };
    if (!owner.identity) throw new Error('Cannot establish Git restore controller identity.');
    await permissions?.prepareParents();
    for (const parent of parents) await canonicalWorkerDirectory(parent);
    await current.check();
    await checkAuthority();
    if (permissions) await permissions.createGuard();
    else if (!await exists(guard)) await mkdir(guard, { mode: 0o700 });
    const guardIdentity = await directoryIdentity(guard, { privateMode: true });
    const before = await collect(files, file => observe(path.join(directory, file)));
    const policy = await collect(['config', 'packed-refs'], async file =>
      ({ file, identity: await observe(path.join(directory, file)) }));
    const directories = await collect(parents, async file =>
      ({ file, identity: await directoryIdentity(file) }));
    permissions?.assertIntentBudget({ project: root, owner, files, before, policy, parents: directories });
    const entries = [];
    for (const [index, file] of files.entries()) {
      await checkAuthority();
      const stagedPath = path.join(directory, `${file}.lock`);
      await permissions?.createStage(path.join(directory, file));
      const handle = await open(stagedPath, permissions ? 'r+' : 'wx', before[index]?.mode ?? 0o644);
      try {
        await handle.writeFile(contents[index]);
        if (process.platform === 'linux') {
          await handle.chown(before[index]?.uid ?? Number(git.info.uid), before[index]?.gid ?? Number(git.info.gid));
          await handle.chmod(before[index]?.mode ?? 0o644);
        }
        await handle.sync();
      } finally { await handle.close(); }
      await permissions?.finishStage(path.join(directory, file));
      await syncWorkerDirectory(path.dirname(stagedPath));
      entries.push({ file, before: before[index], staged: await observe(stagedPath) });
    }
    proofBytes = Buffer.from(`${JSON.stringify({
      version: permissions ? 2 : 1, project: root, owner, recordSha256: hash(Buffer.from(JSON.stringify(record))),
      root: permissions ? await directoryIdentity(directory) : identity(git.info),
      guard: guardIdentity, parents: directories, policy, entries,
    })}\n`);
    if (permissions) await permissions.writeProof(proofBytes);
    else await writeWorkerFile(proofFile, proofBytes);
    await syncWorkerDirectory(guard);
    await syncWorkerDirectory(directory);
    await captureProof();
  }
  const check = async () => {
    await checkAuthority();
    await permissions?.check();
    if (proof.owner.pid !== process.pid && await processIdentity(proof.owner.pid) === proof.owner.identity) {
      throw new Error('The original Git restore controller is still alive.');
    }
    if (!same(await directoryIdentity(directory), proof.root)
      || !same(await directoryIdentity(guard, { privateMode: true }), proof.guard)
      || !same(await readdir(guard), ['intent.json'])
      || !same(identity(await lstat(proofFile, { bigint: true })), proofIdentity)
      || !(await readWorkerFile(proofFile, 65536, { privateMode: true })).equals(proofBytes)) {
      throw new Error('Git restore evidence or directory changed.');
    }
    for (const parent of proof.parents) {
      if (!same(await directoryIdentity(parent.file), parent.identity)) throw new Error('Git ref parent changed.');
    }
    for (const policy of proof.policy) {
      if (!same(await observe(path.join(directory, policy.file)), policy.identity)) throw new Error('Git configuration or packed refs changed.');
    }
    const pending = [];
    for (const entry of proof.entries) {
      const actual = await observe(path.join(directory, entry.file));
      const staged = await observe(path.join(directory, `${entry.file}.lock`));
      if (staged === null && same(actual, entry.staged)) {
        if (pending.length) throw new Error('Gap in Git restore publication sequence.');
      } else if (same(actual, entry.before) && same(staged, entry.staged)) pending.push(entry.file);
      else throw new Error('Git restore target or lockfile changed.');
    }
    for (const parent of [directory, ...parents]) {
      const expected = pending.filter(file => path.dirname(path.join(directory, file)) === parent)
        .map(file => `${path.basename(file)}.lock`).sort();
      if (!same((await readdir(parent)).filter(name => name.endsWith('.lock')).sort(), expected)) {
        throw new Error('Foreign Git writer lock appeared during restoration.');
      }
    }
    return pending;
  };
  for (const file of await check()) {
    await check();
    if (permissions) await permissions.publish(path.join(directory, file), proof.entries.find(entry => entry.file === file));
    else await rename(path.join(directory, `${file}.lock`), path.join(directory, file));
    await syncWorkerDirectory(path.dirname(path.join(directory, file)));
  }
  await check();
  const restored = await inspectGitMetadata({ project: root, commit: record.commit, signal });
  const expected = gitSourceMetadata(record);
  if (!same(restored.record, expected)) throw new Error('Restored Git metadata differs from saved source.');
  await restored.check();
  await check();
  if (permissions) {
    await permissions.verify();
    await check();
    await permissions.retire();
  } else {
    await unlink(proofFile);
    await syncWorkerDirectory(guard);
    await rmdir(guard);
  }
  await syncWorkerDirectory(directory);
  return record;
}
