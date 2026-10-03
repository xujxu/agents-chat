import assert from 'node:assert/strict';
import fs, { chmod, link, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { gitWindowsSecurity as windowsFileSecurity } from './deployment-git-fixture.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreExternalSnapshot } from '../scripts/deployment/restore-external.mjs';
import { inspectWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from '../scripts/deployment/windows-restore-security.mjs';

async function fixture(t, multiple = false) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const directory = path.join(root, 'system');
  await mkdir(project);
  await mkdir(directory);
  await writeFile(path.join(project, 'app.txt'), 'project remains\n');
  const file = path.join(directory, '.env.local');
  const missing = path.join(directory, 'absent.env');
  const unrelated = path.join(directory, 'unrelated.txt');
  await writeFile(file, 'TOKEN=restore-fixture-only\n');
  await writeFile(unrelated, 'unrelated remains\n');
  await windowsFileSecurity(file, 'broaden');
  await chmod(file, 0o400);
  const externalFiles = [{ path: file, optional: false }, { path: missing, optional: true }];
  if (multiple) {
    const parent = path.join(root, 'another-parent');
    await mkdir(parent);
    const second = path.join(parent, 'runtime.json');
    await writeFile(second, '{"fixture":true}\n');
    externalFiles.push({ path: second, optional: false });
  }
  const backup = path.join(root, 'backup');
  const manifest = await createSnapshot({
    project, destination: backup, id: 'native-external-restore', files: ['app.txt'], externalFiles,
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  const saved = new Map();
  for (const entry of externalFiles.filter(entry => !entry.optional)) {
    saved.set(entry.path, await readFile(entry.path));
    await chmod(entry.path, 0o600);
    await writeFile(entry.path, 'updated\n');
  }
  await chmod(file, 0o400);
  await writeFile(missing, 'new configuration\n');
  return { root, project, directory, file, missing, unrelated, backup, manifest, saved, options: {
    project, backup, authorizedPaths: externalFiles.map(entry => entry.path), acceptDataLoss: true,
    checkStopped: async () => ({ stopped: true, inhibited: true }),
  } };
}

async function verifyRestored(f) {
  for (const [file, bytes] of f.saved) assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(lstat(f.missing), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'project remains\n');
  assert.equal(await readFile(f.unrelated, 'utf8'), 'unrelated remains\n');
  for (const parent of f.manifest.windowsExternalSecurity.parents) {
    const entries = parent.metadata.entries.map(entry => ({ path: entry.path, kind: 'file' }));
    const observed = await inspectWindowsSnapshotSecurity({
      project: parent.path, destinationParent: f.backup, entries,
    });
    try { assert.ok(windowsRestoredSecurityMatches(parent.metadata, observed.metadata, entries)); }
    finally { await observed.close(); }
  }
  assert.deepEqual(await verifySnapshot(f.backup), f.manifest);
}

for (const multiple of [false, true]) {
  test(`Windows external restoration privately restores readonly bytes, policy and absence: multiple=${multiple}`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const f = await fixture(t, multiple);
    const originalOpen = fs.open;
    let privateCopies = 0;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (file === f.file && args[0] === 'r+') {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (...values) => {
          assert.doesNotMatch((await windowsFileSecurity(file)).securityDescriptor, /;;;WD\)/);
          privateCopies++;
          return write(...values);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(await restoreExternalSnapshot(f.options), f.manifest);
        await verifyRestored(f);
      }
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(privateCopies, 2);
  });
}

test('Windows external restoration retains private partial copy and retries from the unchanged backup', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file === f.file && args[0] === 'r+') {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async () => {
        await write('partial\n');
        controller.abort(new Error('External copy cancelled'));
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreExternalSnapshot({ ...f.options, signal: controller.signal }), /External copy cancelled/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.file, 'utf8'), 'partial\n');
  assert.doesNotMatch((await windowsFileSecurity(f.file)).securityDescriptor, /;;;WD\)/);
  assert.deepEqual(await verifySnapshot(f.backup), f.manifest);
  await restoreExternalSnapshot(f.options);
  await verifyRestored(f);
});

test('Windows external restoration refuses unauthorized or unsafe resources before mutation', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t, true);
  const bytes = await readFile(f.file);
  const identity = await lstat(f.file, { bigint: true });
  for (const [options, pattern] of [
    [{ acceptDataLoss: false }, /acknowledgement/i],
    [{ authorizedPaths: [f.file] }, /authorization/i],
    [{ checkStopped: async () => ({ stopped: false, inhibited: true }) }, /stopped/i],
  ]) await assert.rejects(restoreExternalSnapshot({ ...f.options, ...options }), pattern);
  const secondParent = f.manifest.windowsExternalSecurity.parents[1].path;
  await chmod(secondParent, 0o400);
  await assert.rejects(restoreExternalSnapshot(f.options), /security|parent|changed/i);
  await chmod(secondParent, 0o700);
  await link(f.file, path.join(f.root, 'outside-alias'));
  await assert.rejects(restoreExternalSnapshot(f.options), /links/i);
  const retained = await lstat(f.file, { bigint: true });
  assert.equal(retained.dev, identity.dev);
  assert.equal(retained.ino, identity.ino);
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal(await readFile(f.missing, 'utf8'), 'new configuration\n');
  assert.deepEqual(await verifySnapshot(f.backup), f.manifest);
});
