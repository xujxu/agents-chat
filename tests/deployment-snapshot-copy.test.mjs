import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inventorySnapshot } from '../scripts/deployment/snapshot-files.mjs';
import { copySnapshotFiles } from '../scripts/deployment/snapshot-copy.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'source');
  const destination = path.join(root, 'files');
  await mkdir(project);
  await mkdir(destination);
  const names = Array.from({ length: 8 }, (_, index) => `file-${index}`);
  for (const [index, name] of names.entries()) {
    await writeFile(path.join(project, name), Buffer.alloc(2 * 1024 * 1024, index));
  }
  const entries = (await inventorySnapshot(project, names)).map(entry => ({ ...entry, sha256: '0'.repeat(64) }));
  return { project, destination, entries };
}

test('bounded snapshot copies preserve every file, checksum and completion count', async t => {
  const scope = await fixture(t);
  const progress = [];
  await copySnapshotFiles({ ...scope, onProgress: record => progress.push(record) });
  for (const entry of scope.entries) {
    const source = await readFile(path.join(scope.project, entry.path));
    assert.deepEqual(await readFile(path.join(scope.destination, entry.path)), source);
    assert.equal(entry.sha256, createHash('sha256').update(source).digest('hex'));
  }
  assert.deepEqual(progress.map(record => record.completed), [0, 2, 4, 6, 8]);
  assert.ok(progress.every(record => record.phase === 'snapshot-copy-files' && record.total === 8));
});

test('failed snapshot batch settles its three peers and never starts the next four files', async t => {
  const scope = await fixture(t);
  scope.entries[0].bytes++;
  await assert.rejects(copySnapshotFiles(scope), /source changed/i);
  assert.deepEqual((await readdir(scope.destination)).sort(), ['file-1', 'file-2', 'file-3']);
  for (const entry of scope.entries.slice(1, 4)) {
    const source = await readFile(path.join(scope.project, entry.path));
    assert.deepEqual(await readFile(path.join(scope.destination, entry.path)), source);
    assert.equal(entry.sha256, createHash('sha256').update(source).digest('hex'));
  }
  assert.ok(scope.entries.slice(4).every(entry => entry.sha256 === '0'.repeat(64)));
});
