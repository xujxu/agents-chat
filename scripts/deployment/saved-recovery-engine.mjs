import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory, writeWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { workerEngineFiles } from './saved-worker-engine.mjs';

const files = Object.freeze([...new Set([
  'saved-recovery-engine.mjs', 'retirement-recovery-entry.mjs', 'retirement-recovery.mjs',
  'saved-worker-engine.mjs', 'worker-files.mjs', 'worker-identity.mjs', 'process-identity.mjs', 'state.mjs',
  'linux-service-recovery.mjs', 'linux-service-inspection.mjs', 'linux-runtime.mjs', 'linux-systemd.mjs',
  'linux-recovery-admission.mjs', 'linux-recovery-completion.mjs',
  'linux-live-retirement.mjs',
  'linux-worker-retirement-handoff.mjs',
  ...workerEngineFiles,
  'linux-restore-entry.mjs', 'linux-restore.mjs', 'linux-restore-compatibility.mjs',
  'restore-transaction.mjs', 'restore-project.mjs', 'restore-external.mjs',
  'linux-configuration.mjs', 'configuration-files.mjs', 'configuration-compatibility.mjs',
  'snapshot.mjs', 'snapshot-files.mjs', 'snapshot-scope.mjs', 'snapshot-external.mjs', 'snapshot-rotation.mjs',
  'linux-readiness.mjs', 'linux-listener.mjs',
])]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = (directory, manifestSha256) => Object.freeze({
  directory, entrypoint: path.join(directory, 'retirement-recovery-entry.mjs'), manifestSha256,
});

export async function verifyRecoveryEngine({ control, manifestSha256 }) {
  if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('Invalid recovery manifest digest.');
  }
  const { root } = await canonicalWorkerDirectory(control, { privateMode: true });
  const { root: directory } = await canonicalWorkerDirectory(path.join(root, 'recovery-engine'), { privateMode: true });
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...files, 'manifest.json'].sort())) {
    throw new Error('Incomplete or unexpected recovery engine files.');
  }
  const bytes = await readWorkerFile(path.join(directory, 'manifest.json'), 32768, { privateMode: true });
  if (digest(bytes) !== manifestSha256) throw new Error('Recovery manifest changed.');
  const manifest = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ['version', 'files'], 'recovery manifest');
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== files.length) {
    throw new Error('Unsupported recovery engine manifest.');
  }
  for (let index = 0; index < files.length; index++) {
    const entry = captureWorkerFields(manifest.files[index], ['name', 'bytes', 'sha256'], 'recovery entry');
    const content = await readWorkerFile(path.join(directory, files[index]), 1024 * 1024, { privateMode: true });
    if (entry.name !== files[index] || entry.bytes !== content.length || entry.sha256 !== digest(content)) {
      throw new Error('Recovery engine file changed.');
    }
  }
  return descriptor(directory, manifestSha256);
}

export async function saveRecoveryEngine({ source, control }) {
  const { root: origin } = await canonicalWorkerDirectory(source);
  const { root } = await canonicalWorkerDirectory(control, { privateMode: true });
  const directory = path.join(root, 'recovery-engine');
  const contents = [];
  for (const name of files) contents.push(await readWorkerFile(path.join(origin, name), 1024 * 1024));
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, files: files.map((name, index) => ({
    name, bytes: contents[index].length, sha256: digest(contents[index]),
  })) })}\n`);
  let exists = true;
  try { await lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    await mkdir(directory, { mode: 0o700 });
    await syncWorkerDirectory(root);
    for (let index = 0; index < files.length; index++) {
      await writeWorkerFile(path.join(directory, files[index]), contents[index]);
    }
    for (let index = 0; index < files.length; index++) {
      if (!(await readWorkerFile(path.join(origin, files[index]), 1024 * 1024)).equals(contents[index])) {
        throw new Error('Recovery source changed while saving.');
      }
    }
    await syncWorkerDirectory(directory);
    await writeWorkerFile(path.join(directory, 'manifest.json'), manifest);
    await syncWorkerDirectory(directory);
  }
  return verifyRecoveryEngine({ control: root, manifestSha256: digest(manifest) });
}

export function retirementRecoveryInvocation(saved, { control, project, operationId, kind = 'worker' }) {
  const fields = captureWorkerFields(saved, ['directory', 'entrypoint', 'manifestSha256'], 'saved recovery engine');
  if (!['worker', 'service'].includes(kind) || !path.isAbsolute(control) || path.resolve(control) !== control
    || !path.isAbsolute(project) || path.resolve(project) !== project
    || typeof operationId !== 'string' || !operationId || operationId.length > 4096 || /[\0\r\n]/.test(operationId)
    || fields.directory !== path.join(control, 'recovery-engine')
    || fields.entrypoint !== path.join(fields.directory, 'retirement-recovery-entry.mjs')
    || !/^[a-f0-9]{64}$/.test(fields.manifestSha256)) throw new Error('Invalid saved recovery invocation.');
  return {
    file: process.execPath,
    args: [fields.entrypoint, control, fields.manifestSha256, project, operationId, ...(kind === 'service' ? [kind] : [])],
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  };
}
