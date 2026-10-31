import assert from 'node:assert/strict';
import streams from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { git, gitMetadataFixture, gitWindowsSecurity } from './deployment-git-fixture.mjs';
import { inspectGitMetadata } from '../scripts/deployment/git-metadata.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { readSnapshotGit } from '../scripts/deployment/snapshot-git.mjs';
import { restoreProjectSnapshot } from '../scripts/deployment/restore-project.mjs';
import { restoreExternalSnapshot } from '../scripts/deployment/restore-external.mjs';
import { inspectWindowsSnapshotSecurity } from '../scripts/deployment/windows-snapshot-security.mjs';
import { windowsRestoredSecurityMatches } from '../scripts/deployment/windows-restore-security.mjs';
import { windowsGitMetadataInventory } from '../scripts/deployment/windows-git-snapshot-security.mjs';
import { prepareWindowsGitMetadataSecurity } from '../scripts/deployment/windows-git-metadata-security.mjs';

async function fixture(t, { broad = true } = {}) {
  const f = await gitMetadataFixture(t, { broad });
  for (const name of ['.data', '.next', 'node_modules', 'logs']) await mkdir(path.join(f.project, name));
  const payload = {
    'app.txt': 'original\n',
    '.data/chats.db': 'saved data fixture\n',
    '.next/BUILD_ID': 'saved build\n',
    'node_modules/dependency': 'saved dependency\n',
    '.env.local': 'TOKEN=project-fixture-only\n',
  };
  for (const [name, bytes] of Object.entries(payload)) await writeFile(path.join(f.project, name), bytes);
  await writeFile(path.join(f.project, 'logs/runtime.log'), 'original log\n');
  const app = path.join(f.project, 'app.txt');
  const index = path.join(f.project, '.git/index');
  await chmod(app, 0o400);
  await chmod(index, 0o400);
  const externalParent = path.join(f.root, 'configuration');
  await mkdir(externalParent);
  const external = path.join(externalParent, '.env.local');
  const absent = path.join(externalParent, 'absent.env');
  await writeFile(external, 'TOKEN=external-fixture-only\n');
  await gitWindowsSecurity(external, 'broaden');
  await chmod(external, 0o400);
  const backup = path.join(f.root, 'backup');
  const manifest = await createSnapshot({
    project: f.project, destination: backup, id: 'native-combined-restore',
    ...await inspectSnapshotScope({ project: f.project }),
    gitMetadata: await inspectGitMetadata(f),
    externalFiles: [{ path: external, optional: false }, { path: absent, optional: true }],
    source: { commit: f.commit, provenance: 'observed' },
    runtime: { platform: 'win32', state: 'stopped' },
  });
  const original = await lstat(f.project, { bigint: true });
  const savedIndex = await readFile(index);
  await chmod(app, 0o600);
  await chmod(index, 0o600);
  await writeFile(app, 'updated\n');
  await git(f.project, 'commit', '-am', 'updated');
  const newer = await git(f.project, 'rev-parse', 'HEAD');
  await git(f.project, 'tag', 'retained-newer', newer);
  for (const name of Object.keys(payload).filter(name => name !== 'app.txt')) {
    await writeFile(path.join(f.project, name), 'updated\n');
  }
  await writeFile(path.join(f.project, 'obsolete-readonly'), 'obsolete\n');
  await chmod(path.join(f.project, 'obsolete-readonly'), 0o400);
  await writeFile(path.join(f.project, 'logs/runtime.log'), 'retained later log\n');
  await chmod(external, 0o600);
  await writeFile(external, 'updated external\n');
  await writeFile(absent, 'later external\n');
  return { ...f, app, index, savedIndex, backup, manifest, original, payload, external, absent, newer, options: {
    project: f.project, backup, expectedSnapshot: manifest, acceptDataLoss: true,
    checkStopped: async () => ({ stopped: true, inhibited: true }),
  } };
}

async function restore(f) {
  assert.deepEqual(await restoreProjectSnapshot(f.options), f.manifest);
  assert.deepEqual(await readFile(f.index), f.savedIndex, 'Project restoration changed the saved index.');
  assert.equal(await readFile(f.external, 'utf8'), 'updated external\n');
  assert.deepEqual(await restoreExternalSnapshot({
    ...f.options, authorizedPaths: [f.external, f.absent],
  }), f.manifest);
  assert.deepEqual(await readFile(f.index), f.savedIndex, 'External restoration changed the saved index.');
}

async function verify(f) {
  const readGit = async (...args) => {
    const output = await git(f.project, '--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', ...args);
    assert.deepEqual(await readFile(f.index), f.savedIndex, `Git verification changed the saved index: ${args[0]}`);
    return output;
  };
  for (const [name, bytes] of Object.entries(f.payload)) assert.equal(await readFile(path.join(f.project, name), 'utf8'), bytes);
  assert.equal(await readFile(path.join(f.project, 'logs/runtime.log'), 'utf8'), 'retained later log\n');
  await assert.rejects(lstat(path.join(f.project, 'obsolete-readonly')), { code: 'ENOENT' });
  assert.equal(await readFile(f.external, 'utf8'), 'TOKEN=external-fixture-only\n');
  await assert.rejects(lstat(f.absent), { code: 'ENOENT' });
  assert.equal(await readGit('rev-parse', 'HEAD'), f.commit);
  assert.equal(await readGit('rev-parse', 'retained-newer'), f.newer);
  assert.equal(await readGit('diff', '--exit-code'), '');
  await readGit('fsck', '--no-dangling');
  const original = await lstat(f.project, { bigint: true });
  assert.equal(original.dev, f.original.dev);
  assert.equal(original.ino, f.original.ino);
  const record = await readSnapshotGit(f.backup, f.manifest);
  assert.deepEqual(await readFile(f.index), Buffer.from(record.index, 'base64'));
  const scopes = [
    { project: f.project, metadata: f.manifest.windowsSecurity, entries: f.manifest.entries },
    { project: path.join(f.project, '.git'), metadata: record.windowsSecurity,
      entries: windowsGitMetadataInventory(record.ref).filter(entry => !record.absentPaths.includes(entry.path)) },
    ...f.manifest.windowsExternalSecurity.parents.map(parent => ({
      project: parent.path, metadata: parent.metadata,
      entries: parent.metadata.entries.map(entry => ({ path: entry.path, kind: 'file' })),
    })),
  ];
  for (const scope of scopes) {
    const observed = await inspectWindowsSnapshotSecurity({ ...scope, destinationParent: f.backup });
    try { assert.ok(windowsRestoredSecurityMatches(scope.metadata, observed.metadata, scope.entries)); }
    finally { await observed.close(); }
  }
  assert.deepEqual(await verifySnapshot(f.backup), f.manifest);
}

test('Windows full snapshot restores project, Git and separately authorized external configuration together', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  await restore(f);
  await verify(f);
});

test('Windows combined restoration retries private project interruption after restoring Git', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const createWriteStream = streams.createWriteStream;
  let injected = false;
  streams.createWriteStream = (file, options) => {
    const stream = createWriteStream(file, options);
    if (file === f.app) {
      injected = true;
      controller.abort(new Error('Combined private project copy cancelled'));
    }
    return stream;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreProjectSnapshot({ ...f.options, signal: controller.signal }),
      error => error.name === 'AbortError' || /Combined private project copy cancelled/.test(error.message));
  } finally {
    streams.createWriteStream = createWriteStream;
    syncBuiltinESMExports();
  }
  assert.ok(injected);
  assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.commit);
  assert.doesNotMatch((await gitWindowsSecurity(f.app)).securityDescriptor, /;;;WD\)/);
  assert.equal(await readFile(f.external, 'utf8'), 'updated external\n');
  assert.deepEqual(await verifySnapshot(f.backup), f.manifest);
  await restore(f);
  await verify(f);
});

test('Windows combined restoration uses explicit PowerShell without PATH lookup', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  assert.ok(f.manifest.gitObjects, 'The test must restore Git objects as well as Git metadata.');
  assert.ok(path.isAbsolute(process.env.DEPLOYMENT_TEST_PWSH));
  f.options.pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await restore(f);
    await restoreExternalSnapshot({ ...f.options, authorizedPaths: [f.external, f.absent] });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  await verify(f);
});

test('Windows combined restoration preserves inherited private Git root policy', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t, { broad: false });
  const record = await readSnapshotGit(f.backup, f.manifest);
  const metadata = record.windowsSecurity;
  const policy = {
    securityDescriptor: metadata.descriptors[metadata.root.security],
    attributes: metadata.root.attributes,
  };
  assert.match(policy.securityDescriptor, /\(A;[^;]*ID;/, 'The Git root must have inherited ACEs.');
  const directory = path.join(f.project, '.git');
  const identity = await lstat(directory, { bigint: true });
  const native = await prepareWindowsGitMetadataSecurity({
    project: f.project, backup: f.backup, record,
  });
  try {
    const observed = await native.observeDirectory(directory, {
      dev: String(identity.dev), ino: String(identity.ino),
    });
    assert.deepEqual(observed.windowsSecurity, policy);
  } finally { await native.close(); }
  const descriptors = [...metadata.descriptors];
  descriptors[metadata.root.security] = policy.securityDescriptor.replaceAll('ID', '');
  await assert.rejects(prepareWindowsGitMetadataSecurity({
    project: f.project, backup: f.backup,
    record: { ...record, windowsSecurity: { ...metadata, descriptors } },
  }), error => /root security policy/.test(error.cause?.message));
  await restore(f);
  await verify(f);
});
