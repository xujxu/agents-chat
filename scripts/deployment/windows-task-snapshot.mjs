import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { assertWindowsTaskSnapshotStage } from './windows-task-transaction.mjs';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { relativeSnapshotPath } from './snapshot-files.mjs';
import { createSnapshot } from './snapshot.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createWindowsTaskSnapshot({
  context, control, lock, configuration, destination, id, source: suppliedSource, recoveryEngine, pwsh, signal, onProgress,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || typeof configuration?.checkFiles !== 'function'
    || !Array.isArray(configuration.files) || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
    || path.resolve(pwsh) !== pwsh || /[\0\r\n]/.test(pwsh)
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('Windows task snapshot requires native configuration observation and explicit PowerShell.');
  }
  const source = Object.freeze(captureWorkerFields(suppliedSource, ['commit', 'provenance'], 'snapshot source'));
  if (!['observed', 'verified'].includes(source.provenance)) throw new Error('Invalid task snapshot source provenance.');
  const authority = { context, control, lock, sourceCommit: source.commit, signal };
  const binding = await assertWindowsTaskSnapshotStage(authority);
  const project = binding.project;
  const bytes = await readWorkerFile(binding.task.configuration, 1024 * 1024, { privateMode: true });
  if (digest(bytes) !== binding.task.configurationSha256) throw new Error('Original task snapshot configuration changed.');
  const runtime = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ['version', 'helpers', 'command'], 'task snapshot configuration');
  if (runtime.version !== 1 || runtime.command?.cwd !== project
    || !runtime.helpers || typeof runtime.helpers !== 'object' || Array.isArray(runtime.helpers)) {
    throw new Error('Unsupported original task snapshot configuration.');
  }
  const helpers = Object.entries(runtime.helpers);
  if (!helpers.length || helpers.length > 63) throw new Error('Unsupported task snapshot helper inventory.');
  const files = [{ path: binding.task.configuration, sha256: binding.task.configurationSha256 }];
  for (const [name, sha256] of helpers) {
    relativeSnapshotPath(name);
    if (name.length > 255 || name.includes('/') || name.toLowerCase() === 'configuration.json'
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Unsupported task snapshot helper name or digest.');
    }
    files.push({ path: path.join(path.dirname(binding.task.configuration), name), sha256 });
  }
  const checkRuntime = async () => {
    signal?.throwIfAborted();
    if (!same(await assertWindowsTaskSnapshotStage(authority), binding)) throw new Error('Original task snapshot binding changed.');
    await configuration.checkFiles({ signal });
    for (const file of files) {
      signal?.throwIfAborted();
      if (digest(await readWorkerFile(file.path, 1024 * 1024, { privateMode: true })) !== file.sha256) {
        throw new Error('Original task snapshot runtime bundle changed.');
      }
    }
    if (!same(await assertWindowsTaskSnapshotStage(authority), binding)) {
      throw new Error('Original task snapshot authority changed after configuration observation.');
    }
  };
  await checkRuntime();
  let hasGit = true;
  try { await lstat(path.join(project, '.git')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasGit = false; }
  onProgress?.({ phase: 'task-git-inventory' });
  const gitMetadata = hasGit ? await inspectGitMetadata({ project, commit: source.commit, signal }) : undefined;
  onProgress?.({ phase: 'task-project-scope' });
  const scope = await inspectSnapshotScope({ project, signal });
  const external = new Map();
  for (const file of [...files.map(file => ({ ...file, present: true })), ...configuration.files]) {
    const relative = path.relative(project, file.path);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) continue;
    if (!external.has(file.path)) external.set(file.path, { path: file.path, optional: !file.present });
  }
  return createSnapshot({
    project, destination, id, source, signal, ...scope, gitMetadata, recoveryEngine, pwsh, onProgress,
    externalFiles: [...external.values()], runtime: { platform: 'win32', state: 'stopped', task: binding.task },
    async checkSource() {
      await checkRuntime();
      await scope.check({ signal });
    },
  });
}
