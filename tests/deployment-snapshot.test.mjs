import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import {
  createSnapshot, verifySnapshot, rotateSnapshot, reconcileSnapshotSlots, estimateRequiredBytes,
} from '../scripts/deployment/snapshot.mjs';

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

async function snapshot(root, slot, id, contents) {
  const project = path.join(root, 'app');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'fixture.db'), contents);
  return createSnapshot({
    project, destination: path.join(root, slot), id, files: ['fixture.db'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
}

test('two rotations retain exactly the latest pre-upgrade snapshot', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await snapshot(root, 'staging', 'one', 'first');
  await rotateSnapshot(root, { project });
  await snapshot(root, 'staging', 'two', 'second');
  await rotateSnapshot(root, { project });
  assert.equal((await verifySnapshot(path.join(root, 'backup'))).id, 'two');
  assert.deepEqual((await readdir(root)).sort(), ['app', 'backup']);
});

test('incomplete replacement preserves the authoritative backup', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await snapshot(root, 'staging', 'one', 'first');
  await rotateSnapshot(root, { project });
  await mkdir(path.join(root, 'staging'));
  await writeFile(path.join(root, 'staging', 'partial'), 'not complete');
  await assert.rejects(rotateSnapshot(root, { project }), /incomplete|manifest|complete/i);
  assert.equal((await verifySnapshot(path.join(root, 'backup'))).id, 'one');
  const result = await reconcileSnapshotSlots(root, { project });
  assert.equal(result.status, 'incomplete-staging');
  assert.equal(result.backupId, 'one');
});

test('corrupt replacement cannot retire the only valid backup', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await snapshot(root, 'staging', 'one', 'first');
  await rotateSnapshot(root, { project });
  await snapshot(root, 'staging', 'two', 'second');
  await writeFile(path.join(root, 'staging', 'files', 'fixture.db'), 'bad');
  await assert.rejects(rotateSnapshot(root, { project }), /checksum|integrity|size/i);
  assert.equal((await verifySnapshot(path.join(root, 'backup'))).id, 'one');
  assert.equal((await readdir(root)).includes('retiring'), false);
});

test('capacity estimate includes copy and caller-specified deployment headroom', () => {
  assert.equal(estimateRequiredBytes({ snapshotBytes: 100, metadataBytes: 10, deploymentBytes: 20 }), 130);
  assert.throws(() => estimateRequiredBytes({ snapshotBytes: -1, metadataBytes: 0, deploymentBytes: 0 }), /bytes/i);
});

test('snapshot refuses a running runtime rather than copying live SQLite data', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await mkdir(project);
  await writeFile(path.join(project, 'fixture.db'), 'live');
  await assert.rejects(createSnapshot({
    project, destination: path.join(root, 'staging'), id: 'running', files: ['fixture.db'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'running' },
  }), /stopped/i);
  assert.deepEqual(await readdir(root), ['app']);
});
