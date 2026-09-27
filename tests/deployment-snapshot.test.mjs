import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';

test('snapshot copies data without aliasing live files and detects corruption', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const destination = path.join(root, 'staging');
  await mkdir(project);
  await writeFile(path.join(project, 'fixture.db'), 'original data');
  await createSnapshot({
    project, destination, id: 'snapshot-one', files: ['fixture.db'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  await writeFile(path.join(project, 'fixture.db'), 'new live data');
  assert.equal(await readFile(path.join(destination, 'files', 'fixture.db'), 'utf8'), 'original data');
  assert.equal((await verifySnapshot(destination)).id, 'snapshot-one');
  await writeFile(path.join(destination, 'files', 'fixture.db'), 'corruption');
  await assert.rejects(verifySnapshot(destination), /checksum|integrity|size/i);
});

test('snapshot rejects external traversal without writing outside destination', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await mkdir(project);
  await writeFile(path.join(root, 'outside'), 'private');
  await assert.rejects(createSnapshot({
    project, destination: path.join(root, 'staging'), id: 'unsafe',
    files: ['../outside'], source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  }), /path|outside|traversal/i);
});
