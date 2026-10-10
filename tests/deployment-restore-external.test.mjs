import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreExternalSnapshot } from '../scripts/deployment/restore-external.mjs';

const linux = { skip: process.platform !== 'linux' };
async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const backup = path.join(root, 'backup');
  const system = path.join(root, 'system');
  await mkdir(project);
  await mkdir(system);
  await writeFile(path.join(project, 'package.json'), '{}');
  const unit = path.join(system, 'app.service');
  const env = path.join(system, 'app.env');
  await writeFile(unit, 'original unit\n');
  await chmod(unit, 0o640);
  await createSnapshot({
    project, destination: backup, id: 'external-restore', files: ['package.json'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: 'linux', state: 'stopped' },
    externalFiles: [{ path: unit, optional: false }, { path: env, optional: true }],
  });
  await writeFile(unit, 'changed unit\n');
  await chmod(unit, 0o600);
  await writeFile(env, 'PRIVATE=new');
  return { root, project, backup, system, unit, env, options: {
    project, backup, authorizedPaths: [unit, env], acceptDataLoss: true,
    checkStopped: async () => ({ stopped: true, inhibited: true }),
  } };
}

test('external restore recovers exact bytes/mode and original absence without consuming backup', linux, async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await restoreExternalSnapshot(f.options)).id, 'external-restore');
    assert.equal(await readFile(f.unit, 'utf8'), 'original unit\n');
    assert.equal((await lstat(f.unit)).mode & 0o777, 0o640);
    await assert.rejects(lstat(f.env), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.system), ['app.service']);
    assert.equal((await verifySnapshot(f.backup)).id, 'external-restore');
  }
  const before = await lstat(f.unit, { bigint: true });
  await restoreExternalSnapshot(f.options);
  const after = await lstat(f.unit, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
  await unlink(f.unit);
  await restoreExternalSnapshot(f.options);
  assert.equal(await readFile(f.unit, 'utf8'), 'original unit\n');
});

test('all external destinations must be explicitly authorized before any write', linux, async t => {
  const f = await fixture(t);
  for (const authorizedPaths of [undefined, [], [f.unit], [f.unit, f.env, f.unit], [f.unit, f.env, '/foreign']]) {
    await assert.rejects(restoreExternalSnapshot({ ...f.options, authorizedPaths }), /authoriz|path/i);
    assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
    assert.equal(await readFile(f.env, 'utf8'), 'PRIVATE=new');
  }
});

test('Linux external restoration refuses Windows runtime relocation before mutation', linux, async t => {
  const f = await fixture(t);
  await assert.rejects(restoreExternalSnapshot({ ...f.options, runtimeBundle: {} }), /requires Windows/);
  assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
  assert.equal(await readFile(f.env, 'utf8'), 'PRIVATE=new');
});

test('external mutation refuses a different backup even when its destination list is unchanged', linux, async t => {
  const f = await fixture(t);
  const expectedSnapshot = await verifySnapshot(f.backup);
  expectedSnapshot.source.commit = 'b'.repeat(40);
  await assert.rejects(restoreExternalSnapshot({ ...f.options, expectedSnapshot }), /admitted|changed|backup/i);
  assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
  assert.equal(await readFile(f.env, 'utf8'), 'PRIVATE=new');
});

test('invalid acknowledgement or stop evidence refuses external mutation', linux, async t => {
  const f = await fixture(t);
  for (const overrides of [
    { acceptDataLoss: false }, { checkStopped: undefined },
    { checkStopped: async () => ({ stopped: true, inhibited: false }) },
  ]) {
    await assert.rejects(restoreExternalSnapshot({ ...f.options, ...overrides }));
    assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
  }
});

for (const type of ['symlink', 'hardlink', 'directory']) {
  test(`unsafe later external ${type} refuses before restoring any earlier path`, linux, async t => {
    const f = await fixture(t);
    await unlink(f.env);
    if (type === 'symlink') await symlink(f.unit, f.env);
    if (type === 'hardlink') await link(f.unit, f.env);
    if (type === 'directory') await mkdir(f.env);
    await assert.rejects(restoreExternalSnapshot(f.options), /file|link|type/i);
    assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
  });
}

test('corrupt payload refuses external mutation', linux, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.backup, 'external', '0'), 'corrupt');
  await assert.rejects(restoreExternalSnapshot(f.options), /checksum|integrity/i);
  assert.equal(await readFile(f.unit, 'utf8'), 'changed unit\n');
});

test('missing external parent refuses instead of inventing directory permissions', linux, async t => {
  const f = await fixture(t);
  await rename(f.system, path.join(f.root, 'held-system'));
  await assert.rejects(restoreExternalSnapshot(f.options), { code: 'ENOENT' });
  await assert.rejects(lstat(f.system), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.root, 'held-system/app.service'), 'utf8'), 'changed unit\n');
});

test('external restoration cancellation keeps the backup and permits exact retry', linux, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(restoreExternalSnapshot({
    ...f.options, signal: controller.signal, checkStopped: async () => {
      if (++calls === 3) controller.abort(new Error('cancel external restore'));
      return { stopped: true, inhibited: true };
    },
  }), /cancel external restore/);
  assert.equal((await verifySnapshot(f.backup)).id, 'external-restore');
  await restoreExternalSnapshot(f.options);
  assert.equal(await readFile(f.unit, 'utf8'), 'original unit\n');
  await assert.rejects(lstat(f.env), { code: 'ENOENT' });
});

test('Windows external restoration requires explicit acknowledgement and runtime authority', {
  skip: process.platform !== 'win32',
}, async () => {
  await assert.rejects(restoreExternalSnapshot({}), /acknowledgement|stopped/i);
});
