import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, writeFile, readdir, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import {
  createSnapshot, verifySnapshot, rotateSnapshot, reconcileSnapshotSlots, estimateRequiredBytes, inventorySnapshot,
} from '../scripts/deployment/snapshot.mjs';
import { fileDigest } from '../scripts/deployment/snapshot-files.mjs';

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

for (const change of ['contents', 'inventory', 'permissions', 'copied-payload']) {
  test(`snapshot refuses ${change} changed at the final authority boundary before marking complete`, {
    skip: change === 'permissions' && process.platform !== 'linux',
  }, async t => {
    const root = await temporaryDeployment(t);
    const project = path.join(root, 'app');
    const destination = path.join(root, 'staging');
    await mkdir(path.join(project, 'data'), { recursive: true });
    const file = path.join(project, 'data', 'saved');
    await writeFile(file, 'before');
    if (change === 'permissions') await chmod(file, 0o644);
    let checks = 0;
    await assert.rejects(createSnapshot({
      project, destination, id: 'changing', files: ['data'],
      source: { commit: 'a'.repeat(40), provenance: 'observed' },
      runtime: { platform: process.platform, state: 'stopped' },
      async checkSource() {
        if (++checks !== 2) return;
        if (change === 'contents') await writeFile(file, 'after!');
        if (change === 'inventory') await writeFile(path.join(project, 'data', 'new'), 'new file');
        if (change === 'permissions') await chmod(file, 0o600);
        if (change === 'copied-payload') await writeFile(path.join(destination, 'files', 'data', 'saved'), 'after!');
      },
    }), /source|changed|checksum|integrity/i);
    await assert.rejects(readFile(path.join(destination, 'complete.json')), { code: 'ENOENT' });
  });
}

test('cancelled snapshot, inventory and verification do not create or mutate snapshot contents', async t => {
  const root = await temporaryDeployment(t);
  await snapshot(root, 'backup', 'retained', 'original');
  const project = path.join(root, 'app');
  const controller = new AbortController();
  const reason = new Error('cancelled snapshot operation');
  controller.abort(reason);
  const signal = controller.signal;
  await assert.rejects(createSnapshot({
    project, destination: path.join(root, 'staging'), id: 'cancelled', files: ['fixture.db'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' }, signal,
  }), error => error === reason);
  await assert.rejects(inventorySnapshot(project, ['fixture.db'], { signal }), error => error === reason);
  await assert.rejects(verifySnapshot(path.join(root, 'backup'), { signal }), error => error === reason);
  assert.deepEqual((await readdir(root)).sort(), ['app', 'backup']);
  assert.equal((await verifySnapshot(path.join(root, 'backup'))).id, 'retained');
});

test('stream hashing observes in-flight cancellation and closes its file before settling', async t => {
  const root = await temporaryDeployment(t);
  const file = path.join(root, 'payload');
  await writeFile(file, Buffer.alloc(1024 * 1024, 42));
  const controller = new AbortController();
  const hashing = fileDigest(file, { signal: controller.signal });
  controller.abort(new Error('stop hashing'));
  await assert.rejects(hashing, /abort|stop hashing/i);
  await unlink(file);
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

test('two rotations retain exactly the latest pre-update snapshot', async t => {
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

for (const promoted of [false, true]) {
  test(`rotation resumes after ${promoted ? 'promotion' : 'retirement'} rename`, async t => {
    const root = await temporaryDeployment(t);
    const project = path.join(root, 'app');
    await snapshot(root, 'staging', 'one', 'first');
    await rotateSnapshot(root, { project });
    await snapshot(root, 'staging', 'two', 'second');
    await writeFile(path.join(root, 'rotation.json'), JSON.stringify({
      version: 1, project, oldId: 'one', newId: 'two',
    }));
    await rename(path.join(root, 'backup'), path.join(root, 'retiring'));
    if (promoted) await rename(path.join(root, 'staging'), path.join(root, 'backup'));
    assert.equal((await reconcileSnapshotSlots(root, { project })).status, 'interrupted-rotation');
    await rotateSnapshot(root, { project });
    assert.equal((await verifySnapshot(path.join(root, 'backup'))).id, 'two');
    assert.deepEqual((await readdir(root)).sort(), ['app', 'backup']);
  });
}

test('foreign project cannot rotate or discard someone else snapshot', async t => {
  const root = await temporaryDeployment(t);
  await snapshot(root, 'staging', 'one', 'first');
  const other = path.join(root, 'other');
  await mkdir(other);
  await assert.rejects(rotateSnapshot(root, { project: other }), /foreign|owner/i);
  assert.equal((await verifySnapshot(path.join(root, 'staging'))).id, 'one');
});

test('unexpected content blocks deletion of a retiring snapshot', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await snapshot(root, 'staging', 'one', 'first');
  await rotateSnapshot(root, { project });
  await snapshot(root, 'staging', 'two', 'second');
  await writeFile(path.join(root, 'backup', 'user-file'), 'do not discard');
  await assert.rejects(rotateSnapshot(root, { project }), /unexpected/i);
  assert.equal(await readFile(path.join(root, 'backup', 'user-file'), 'utf8'), 'do not discard');
});

test('nested selected files capture their parents and empty directories', async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'nested', 'empty'), { recursive: true });
  await writeFile(path.join(project, 'nested', 'data'), 'payload');
  const manifest = await createSnapshot({
    project, destination: path.join(root, 'staging'), id: 'nested',
    files: ['nested/data', 'nested/empty'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  assert.deepEqual(manifest.entries.map(entry => entry.path).sort(), ['nested', 'nested/data', 'nested/empty']);
});

test('linux relative executable links remain confined to captured files', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await mkdir(path.join(project, '.bin'), { recursive: true });
  await writeFile(path.join(project, 'engine'), 'executable');
  await symlink('../engine', path.join(project, '.bin', 'engine'));
  await createSnapshot({
    project, destination: path.join(root, 'staging'), id: 'links',
    files: ['.bin', 'engine'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  assert.equal((await verifySnapshot(path.join(root, 'staging'))).id, 'links');
  await unlink(path.join(root, 'staging', 'files', '.bin', 'engine'));
  await symlink(path.join(project, 'engine'), path.join(root, 'staging', 'files', '.bin', 'engine'));
  await assert.rejects(verifySnapshot(path.join(root, 'staging')), /external/i);
});
