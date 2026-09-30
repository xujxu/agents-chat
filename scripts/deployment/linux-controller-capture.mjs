import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, readWorkerFile, writeWorkerFile } from './worker-files.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function captureLinuxController({ source, project, signal }) {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('Controller capture requires the Linux root controller.');
  }
  const origin = await canonicalWorkerDirectory(source);
  const target = await canonicalWorkerDirectory(project);
  const temporary = await canonicalWorkerDirectory('/tmp');
  if (temporary.info.uid !== 0 || temporary.info.mode & 0o022 && !(temporary.info.mode & 0o1000)
    || target.root === '/' || target.root === temporary.root || temporary.root.startsWith(`${target.root}/`)) {
    throw new Error('Controller capture requires a trusted temporary directory outside the installed project.');
  }
  const helpers = path.join(origin.root, 'scripts/deployment');
  const original = await canonicalWorkerDirectory(helpers);
  const inventory = async () => {
    const entries = await readdir(helpers, { withFileTypes: true });
    if (!entries.length || entries.length > 256 || entries.some(entry =>
      !entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:mjs|json|ps1|cs)$/.test(entry.name))) {
      throw new Error('Unsupported controller helper inventory or links.');
    }
    return entries.map(entry => entry.name).sort();
  };
  const names = await inventory();
  if (!names.includes('linux-update-command.mjs')) throw new Error('Controller command entry is missing.');
  const files = [...names.map(name => `scripts/deployment/${name}`), 'lib/workflow/workflowSchema.mjs'];
  let directory;
  let identity;
  let closed = false;
  const close = async () => {
    if (closed || !directory) return;
    const current = await canonicalWorkerDirectory(directory, { privateMode: true });
    if (!sameDirectory(current.info, identity)) throw new Error('Captured controller directory was replaced; retain it.');
    await rm(directory, { recursive: true });
    closed = true;
  };
  try {
    signal?.throwIfAborted();
    directory = await mkdtemp(path.join(temporary.root, 'agents-chat-controller-'));
    identity = (await canonicalWorkerDirectory(directory, { privateMode: true })).info;
    await mkdir(path.join(directory, 'scripts/deployment'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(directory, 'lib/workflow'), { recursive: true, mode: 0o700 });
    const captured = [];
    let total = 0;
    for (const file of files) {
      signal?.throwIfAborted();
      await canonicalWorkerDirectory(path.dirname(path.join(origin.root, file)));
      const bytes = await readWorkerFile(path.join(origin.root, file), 1024 * 1024);
      total += bytes.length;
      if (total > 16 * 1024 * 1024) throw new Error('Controller helper capture exceeds its byte budget.');
      await writeWorkerFile(path.join(directory, file), bytes);
      captured.push({ file, sha256: digest(bytes) });
    }
    if (!sameDirectory((await lstat(origin.root)), origin.info)
      || !sameDirectory((await canonicalWorkerDirectory(helpers)).info, original.info)
      || JSON.stringify(await inventory()) !== JSON.stringify(names)) {
      throw new Error('Controller source inventory changed during capture.');
    }
    for (const { file, sha256 } of captured) {
      signal?.throwIfAborted();
      if (digest(await readWorkerFile(path.join(origin.root, file), 1024 * 1024)) !== sha256
        || digest(await readWorkerFile(path.join(directory, file), 1024 * 1024, { privateMode: true })) !== sha256) {
        throw new Error('Controller helper changed during capture.');
      }
    }
    return Object.freeze({ directory, entrypoint: path.join(directory, 'scripts/deployment/linux-update-command.mjs'), close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Controller capture and cleanup failed.'); }
    throw error;
  }
}
