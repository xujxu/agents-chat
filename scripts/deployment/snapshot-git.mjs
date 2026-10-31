import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureWorkerFields } from './worker-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { validateGitMetadata } from './git-metadata.mjs';

const maximum = 24 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateSnapshotGit(value) {
  const descriptor = captureWorkerFields(value, ['version', 'bytes', 'sha256'], 'snapshot Git metadata');
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
    || descriptor.bytes > maximum || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? '')) {
    throw new Error('Invalid snapshot Git metadata descriptor.');
  }
  return descriptor;
}

export async function captureSnapshotGit(metadata, commit, security) {
  if (typeof metadata?.check !== 'function') throw new Error('Snapshot Git metadata requires retained source authority.');
  await metadata.check();
  const base = validateGitMetadata(metadata.record, commit);
  const record = security ? validateGitMetadata({
    ...base, version: 2, windowsSecurity: security.windowsSecurity, absentPaths: security.absentPaths,
  }, commit) : base;
  const bytes = Buffer.from(JSON.stringify(record));
  const descriptor = validateSnapshotGit({ version: 1, bytes: bytes.length, sha256: digest(bytes) });
  return { bytes, descriptor, record };
}

export async function readSnapshotGit(backup, manifest) {
  const descriptor = validateSnapshotGit(manifest.gitMetadata);
  const bytes = await readWorkerFile(path.join(backup, 'git.json'), maximum, { privateMode: true });
  if (bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256) {
    throw new Error('Snapshot Git metadata checksum integrity failure.');
  }
  const record = validateGitMetadata(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), manifest.source.commit);
  if (record.version === 2 && manifest.runtime?.platform !== 'win32') {
    throw new Error('Windows Git metadata requires a matching Windows snapshot runtime.');
  }
  return record;
}
