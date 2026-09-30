import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { runStage } from './stage-runner.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

export async function prepareLinuxRestoreInvocation({ project, timeoutSeconds = 1800, signal }) {
  if (process.platform !== 'linux' || process.getuid() !== 0
    || typeof project !== 'string' || !path.isAbsolute(project)
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Public restore requires Linux root and a positive stage deadline.');
  }
  return runStage('restore-command-admission', async stageSignal => {
    const { root } = await canonicalWorkerDirectory(project);
    if (root === '/') throw new Error('The filesystem root cannot be a deployment restore project.');
    const control = path.join(path.dirname(root), `.${path.basename(root)}.deployment`);
    await canonicalWorkerDirectory(control, { privateMode: true });
    const engine = await canonicalWorkerDirectory(path.join(control, 'recovery-engine'), { privateMode: true });
    const file = path.join(engine.root, 'manifest.json');
    const bytes = await readWorkerFile(file, 32768, { privateMode: true });
    const manifest = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ['version', 'files'], 'saved restore manifest');
    if (manifest.version !== 1 || !Array.isArray(manifest.files)
      || !manifest.files.length || manifest.files.length > 256) throw new Error('Unsupported saved recovery manifest.');
    const names = new Set();
    let total = 0;
    for (const item of manifest.files) {
      stageSignal.throwIfAborted();
      const entry = captureWorkerFields(item, ['name', 'bytes', 'sha256'], 'saved restore helper');
      if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:mjs|ps1|cs)$/.test(entry.name)
        || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 1024 * 1024
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error('Invalid saved recovery helper descriptor.');
      }
      names.add(entry.name);
      total += entry.bytes;
      if (total > 16 * 1024 * 1024) throw new Error('Saved recovery helpers exceed the supported byte budget.');
      const content = await readWorkerFile(path.join(engine.root, entry.name), 1024 * 1024, { privateMode: true });
      if (content.length !== entry.bytes || hash(content) !== entry.sha256) throw new Error('Saved recovery helper integrity failure.');
    }
    if (!names.has('linux-restore-entry.mjs') || !names.has('saved-recovery-engine.mjs')
      || JSON.stringify((await readdir(engine.root)).sort()) !== JSON.stringify([...names, 'manifest.json'].sort())
      || !(await readWorkerFile(file, 32768, { privateMode: true })).equals(bytes)) {
      throw new Error('Saved recovery engine inventory or manifest changed.');
    }
    const backup = path.join(control, 'backup');
    const snapshot = await verifySnapshot(backup, { signal: stageSignal });
    const runtime = snapshot.runtime;
    if (snapshot.project !== root || snapshot.scope !== 'project' || runtime?.platform !== 'linux'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(runtime.unit ?? '')
      || !Array.isArray(runtime.executables) || runtime.executables.length !== 2
      || runtime.executables.some(executable => !['file', 'target'].every(key =>
        typeof executable?.[key] === 'string' && path.isAbsolute(executable[key])
        && !/[\0\r\n]/.test(executable[key]) && !inside(root, executable[key])))
      || inside(root, process.execPath)) {
      throw new Error('Saved backup does not establish this project and an external Linux runtime.');
    }
    const current = await canonicalWorkerDirectory(engine.root, { privateMode: true });
    if (current.info.dev !== engine.info.dev || current.info.ino !== engine.info.ino) {
      throw new Error('Saved recovery engine directory was replaced.');
    }
    return Object.freeze({
      file: process.execPath,
      args: Object.freeze([path.join(engine.root, 'linux-restore-entry.mjs'), control, hash(bytes), '--accept-data-loss']),
      input: Object.freeze({ project: root, unit: runtime.unit,
        npm: runtime.executables[0].file, node: runtime.executables[1].file,
        backup, port: 3010, waitSeconds: 120, timeoutSeconds }),
      backupId: snapshot.id,
    });
  }, { timeoutMs: Math.min(timeoutSeconds * 1000, 2147483647), signal });
}
