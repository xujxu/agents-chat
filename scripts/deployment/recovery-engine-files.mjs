import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

export const recoveryDigest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function locateRecoveryEngine({ control, manifestSha256 }) {
  const { root } = await canonicalWorkerDirectory(control, { privateMode: true });
  const legacy = path.join(root, 'recovery-engine');
  if (manifestSha256 === undefined) return legacy;
  if (typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error('Invalid recovery engine digest.');
  }
  const generated = path.join(root, `recovery-engine-${manifestSha256}`);
  try { await lstat(generated); return generated; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await canonicalWorkerDirectory(legacy, { privateMode: true });
  const bytes = await readWorkerFile(path.join(legacy, 'manifest.json'), 32768, { privateMode: true });
  if (recoveryDigest(bytes) !== manifestSha256) throw new Error('Recovery engine digest does not match the backup or invocation.');
  return legacy;
}

export async function readRecoveryEngineManifest({ directory, manifestSha256 }) {
  await canonicalWorkerDirectory(directory, { privateMode: true });
  const file = path.join(directory, 'manifest.json');
  const bytes = await readWorkerFile(file, 32768, { privateMode: true });
  const digest = recoveryDigest(bytes);
  if (manifestSha256 !== undefined && digest !== manifestSha256) throw new Error('Recovery engine digest changed.');
  const manifest = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    ['version', 'files'], 'saved restore manifest');
  if (manifest.version !== 1 || !Array.isArray(manifest.files)
    || !manifest.files.length || manifest.files.length > 256) throw new Error('Unsupported saved recovery manifest.');
  const names = new Set();
  let total = 0;
  for (const item of manifest.files) {
    const entry = captureWorkerFields(item, ['name', 'bytes', 'sha256'], 'saved restore helper');
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:mjs|ps1|cs)$/.test(entry.name)
      || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 1024 * 1024
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Invalid saved recovery helper descriptor.');
    }
    names.add(entry.name);
    total += entry.bytes;
    if (total > 16 * 1024 * 1024) throw new Error('Saved recovery helpers exceed the supported byte budget.');
  }
  if (!names.has('linux-restore-entry.mjs') || !names.has('saved-recovery-engine.mjs')) {
    throw new Error('Saved recovery engine inventory is incomplete.');
  }
  return { manifestSha256: digest, manifest, bytes };
}

export async function inspectRecoveryEngineFiles({ directory, manifestSha256, signal }) {
  const engine = await canonicalWorkerDirectory(directory, { privateMode: true });
  const { manifest, bytes, manifestSha256: digest } = await readRecoveryEngineManifest({ directory, manifestSha256 });
  for (const entry of manifest.files) {
    signal?.throwIfAborted();
    const content = await readWorkerFile(path.join(directory, entry.name), 1024 * 1024, { privateMode: true });
    if (content.length !== entry.bytes || recoveryDigest(content) !== entry.sha256) {
      throw new Error('Saved recovery helper integrity failure.');
    }
  }
  if (JSON.stringify((await readdir(engine.root)).sort()) !== JSON.stringify([...manifest.files.map(entry => entry.name), 'manifest.json'].sort())
    || !(await readWorkerFile(path.join(directory, 'manifest.json'), 32768, { privateMode: true })).equals(bytes)) {
    throw new Error('Saved recovery engine inventory or manifest changed.');
  }
  const current = await canonicalWorkerDirectory(engine.root, { privateMode: true });
  if (current.info.dev !== engine.info.dev || current.info.ino !== engine.info.ino) {
    throw new Error('Saved recovery engine directory was replaced.');
  }
  return { directory: engine.root, manifestSha256: digest, manifest, info: engine.info };
}
