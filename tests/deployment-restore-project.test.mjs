import assert from 'node:assert/strict';
import fs, { chmod, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreProjectSnapshot } from '../scripts/deployment/restore-project.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

async function fixture(t, full = true, beforeSnapshot) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const backup = path.join(root, 'backup');
  for (const name of ['.data', '.next', 'node_modules', 'logs', '.git']) {
    await mkdir(path.join(project, name), { recursive: true });
  }
  for (const [name, content] of Object.entries({
    'package.json': '{"scripts":{"build":"exit 91","start":"exit 92"}}',
    '.data/chats.db': 'saved data', '.next/BUILD_ID': 'saved build',
    'node_modules/saved': 'saved dependency', 'logs/runtime.log': 'old log', '.git/HEAD': 'git metadata',
    '.env.local': 'PRIVATE=saved',
  })) await writeFile(path.join(project, name), content);
  await chmod(path.join(project, '.env.local'), 0o600);
  await chmod(project, 0o750);
  if (process.platform === 'linux') {
    await symlink('z-build-link', path.join(project, 'build-link'));
    await symlink('.next/BUILD_ID', path.join(project, 'z-build-link'));
  }
  await beforeSnapshot?.(project);
  const scope = full ? await inspectSnapshotScope({ project }) : { files: ['package.json'] };
  await createSnapshot({
    project, destination: backup, id: 'restore-point', ...scope,
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  await writeFile(path.join(project, '.data/chats.db'), 'post-backup data');
  await writeFile(path.join(project, '.next/BUILD_ID'), 'failed build');
  await writeFile(path.join(project, 'nodes.json'), 'new configuration');
  await writeFile(path.join(project, 'new-source'), 'new source');
  await writeFile(path.join(project, 'logs/runtime.log'), 'new log');
  return { root, project, backup, options: {
    project, backup, acceptDataLoss: true,
    checkStopped: async () => ({ stopped: true, inhibited: true }),
  } };
}

const linux = { skip: process.platform !== 'linux' };

async function inspectWindowsSecurity(file, action = 'inspect') {
  const { stdout } = await promisify(execFile)('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-snapshot-security-fixture.ps1', import.meta.url)),
    '-File', file, '-Action', action,
  ], { timeout: 30000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}

test('Windows project payload restore applies original ACLs, removes read-only obsolete content and is retryable', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t, true, project => inspectWindowsSecurity(path.join(project, '.env.local'), 'broaden'));
  const manifest = await verifySnapshot(f.backup);
  const security = manifest.windowsSecurity;
  const saved = security.entries.find(entry => entry.path === '.env.local');
  const descriptor = security.descriptors[saved.security];
  assert.match(descriptor, /;;;WD\)/);
  const original = await lstat(f.project);
  await writeFile(path.join(f.project, 'obsolete-readonly'), 'obsolete');
  await chmod(path.join(f.project, 'obsolete-readonly'), 0o400);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await restoreProjectSnapshot(f.options)).id, 'restore-point');
    assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'saved data');
    assert.equal(await readFile(path.join(f.project, '.next/BUILD_ID'), 'utf8'), 'saved build');
    assert.equal(await readFile(path.join(f.project, 'node_modules/saved'), 'utf8'), 'saved dependency');
    assert.equal(await readFile(path.join(f.project, 'logs/runtime.log'), 'utf8'), 'new log');
    assert.equal(await readFile(path.join(f.project, '.git/HEAD'), 'utf8'), 'git metadata');
    const observed = await inspectWindowsSecurity(path.join(f.project, '.env.local'));
    assert.equal(observed.securityDescriptor, descriptor);
    assert.equal(observed.attributes, saved.attributes);
    for (const name of ['nodes.json', 'new-source', 'obsolete-readonly']) {
      await assert.rejects(lstat(path.join(f.project, name)), { code: 'ENOENT' });
    }
    assert.equal((await lstat(f.project)).ino, original.ino);
    assert.deepEqual(await verifySnapshot(f.backup), manifest);
    assert.doesNotMatch((await inspectWindowsSecurity(path.join(f.backup, 'files/.env.local'))).securityDescriptor, /;;;WD\)/);
    assert.deepEqual((await readdir(f.root)).sort(), ['app', 'backup']);
  }
});

test('project mutation refuses a different backup from the one admitted before downtime', linux, async t => {
  const f = await fixture(t);
  const expectedSnapshot = await verifySnapshot(f.backup);
  expectedSnapshot.source.commit = 'b'.repeat(40);
  await assert.rejects(restoreProjectSnapshot({ ...f.options, expectedSnapshot }), /admitted|changed|backup/i);
  assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'post-backup data');
});

test('project restore replaces source/data/artifacts directly, preserves backup and excluded roots, and is retryable', linux, async t => {
  const f = await fixture(t);
  const original = await lstat(f.project);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await restoreProjectSnapshot(f.options);
    assert.equal(result.id, 'restore-point');
    assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'saved data');
    assert.equal(await readFile(path.join(f.project, '.next/BUILD_ID'), 'utf8'), 'saved build');
    assert.equal(await readFile(path.join(f.project, 'node_modules/saved'), 'utf8'), 'saved dependency');
    assert.equal((await lstat(path.join(f.project, 'build-link'))).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(f.project, 'build-link'), 'utf8'), 'saved build');
    assert.equal(await readFile(path.join(f.project, 'logs/runtime.log'), 'utf8'), 'new log');
    assert.equal(await readFile(path.join(f.project, '.git/HEAD'), 'utf8'), 'git metadata');
    assert.equal((await lstat(path.join(f.project, '.env.local'))).mode & 0o777, 0o600);
    for (const name of ['nodes.json', 'new-source']) {
      await assert.rejects(lstat(path.join(f.project, name)), { code: 'ENOENT' });
    }
    const restored = await lstat(f.project);
    assert.equal(restored.ino, original.ino);
    assert.equal(restored.mode & 0o777, original.mode & 0o777);
    assert.equal((await verifySnapshot(f.backup)).id, 'restore-point');
    assert.deepEqual((await readdir(f.root)).sort(), ['app', 'backup']);
  }
});

test('restore refusal without acknowledgement, stopped authority or full scope never changes live data', linux, async t => {
  const f = await fixture(t);
  for (const overrides of [
    { acceptDataLoss: false }, { checkStopped: undefined },
    { checkStopped: async () => ({ stopped: false, inhibited: true }) },
    { checkStopped: async () => ({ stopped: true, inhibited: false }) },
  ]) {
    await assert.rejects(restoreProjectSnapshot({ ...f.options, ...overrides }));
    assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'post-backup data');
  }
  const partial = await fixture(t, false);
  await assert.rejects(restoreProjectSnapshot(partial.options), /scope|complete.project/i);
  assert.equal(await readFile(path.join(partial.project, '.data/chats.db'), 'utf8'), 'post-backup data');
});

test('corrupt backup and foreign project refuse before any deletion', linux, async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'foreign');
  await mkdir(foreign);
  await assert.rejects(restoreProjectSnapshot({ ...f.options, project: foreign }), /project|owner/i);
  await writeFile(path.join(f.backup, 'files/.data/chats.db'), 'corrupt');
  await assert.rejects(restoreProjectSnapshot(f.options), /checksum|integrity/i);
  assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'post-backup data');
});

test('links out of the current installation refuse without touching the outside target', linux, async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await writeFile(outside, 'foreign');
  await symlink(outside, path.join(f.project, 'redirect'));
  await assert.rejects(restoreProjectSnapshot(f.options), /link|external/i);
  assert.equal(await readFile(outside, 'utf8'), 'foreign');
  assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'post-backup data');
});

test('lost stopped authority leaves the authoritative backup intact for retry', linux, async t => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(restoreProjectSnapshot({ ...f.options, checkStopped: async () => {
    if (++checks === 3) throw new Error('stopped authority lost');
    return { stopped: true, inhibited: true };
  } }), /authority lost/);
  assert.equal((await verifySnapshot(f.backup)).id, 'restore-point');
  await restoreProjectSnapshot(f.options);
  assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'saved data');
});

test('cancelled project restoration leaves the backup unchanged and can be retried', linux, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(restoreProjectSnapshot({
    ...f.options, signal: controller.signal, checkStopped: async () => {
      if (++checks === 4) controller.abort(new Error('cancel restoration'));
      return { stopped: true, inhibited: true };
    },
  }), /cancel restoration/);
  assert.equal((await verifySnapshot(f.backup)).id, 'restore-point');
  await restoreProjectSnapshot(f.options);
  assert.equal(await readFile(path.join(f.project, '.next/BUILD_ID'), 'utf8'), 'saved build');
});

test('interruption after creating any restored link never leaves a dangling link that blocks retry', linux, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const nativeSymlink = fs.symlink;
  let copiedLink;
  fs.symlink = async (...args) => {
    const result = await nativeSymlink(...args);
    copiedLink = args[1];
    controller.abort(new Error('interrupt after creating link'));
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreProjectSnapshot({ ...f.options, signal: controller.signal }), /interrupt after creating link/);
  } finally {
    fs.symlink = nativeSymlink;
    syncBuiltinESMExports();
  }
  assert.ok(copiedLink);
  assert.equal(await realpath(copiedLink), path.join(f.project, '.next/BUILD_ID'));
  await restoreProjectSnapshot(f.options);
  assert.equal(await readFile(path.join(f.project, 'build-link'), 'utf8'), 'saved build');
  assert.equal((await verifySnapshot(f.backup)).id, 'restore-point');
});

test('Windows project restoration refuses until a native ACL adapter is supplied', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  await assert.rejects(restoreProjectSnapshot(f.options), /Linux|Windows|ACL/i);
  assert.equal(await readFile(path.join(f.project, '.data/chats.db'), 'utf8'), 'post-backup data');
});
