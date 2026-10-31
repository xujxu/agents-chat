import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';

async function installation(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project');
  await mkdir(project);
  async function file(name, bytes = 'retained') {
    await mkdir(path.dirname(path.join(project, name)), { recursive: true });
    await writeFile(path.join(project, name), bytes);
  }
  await file('package.json', '{"name":"fixture"}');
  await file('app/page.tsx');
  await file('.git/config', 'excluded');
  await file('.env.local', 'PRIVATE_VALUE=retained');
  await file('.data/deployments/models/model.bin');
  await file('.next/server/app/index.html');
  await file('.next/cache/compiler');
  await file('node_modules/dependency/index.js');
  await file('node_modules/.cache/build');
  await file('logs/app.log');
  await file('.npm/_cacache/content');
  return { root, project, file };
}

test('scope includes source, runtime, dependencies and model data without Git/log/build cache trees', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  assert.ok(scope.files.includes('app'));
  assert.ok(scope.files.includes('.data'));
  assert.ok(scope.files.includes('node_modules'));
  assert.equal(scope.files.includes('.git'), false);
  assert.equal(scope.files.includes('logs'), false);
  assert.equal(scope.files.includes('.npm'), false);
  assert.ok(scope.absentPaths.includes('.env.production.local'));
  assert.ok(scope.absentPaths.includes('nodes.json'));
  assert.equal(scope.absentPaths.includes('.env.local'), false);
  assert.ok(scope.snapshotBytes > 0);
  const destination = path.join(f.root, 'staging');
  const manifest = await createSnapshot({
    project: f.project, destination, id: 'complete-scope', ...scope,
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  const info = await lstat(f.project);
  assert.equal(manifest.scope, 'project');
  assert.deepEqual(manifest.projectMetadata, { mode: info.mode & 0o777, uid: info.uid, gid: info.gid });
  const paths = manifest.entries.map(entry => entry.path);
  assert.ok(paths.includes('.data/deployments/models/model.bin'));
  assert.ok(paths.includes('.next/server/app/index.html'));
  assert.ok(paths.includes('node_modules/dependency/index.js'));
  assert.equal(paths.some(name => name === '.git' || name.startsWith('.git/')), false);
  assert.equal(paths.some(name => name.startsWith('.next/cache/')), false);
  assert.equal(paths.some(name => name.startsWith('node_modules/.cache/')), false);
  assert.deepEqual(manifest.absentPaths, scope.absentPaths);
  assert.equal(await readFile(path.join(destination, 'files', '.env.local'), 'utf8'), 'PRIVATE_VALUE=retained');
  await verifySnapshot(destination);
});

test('a selected-file snapshot cannot claim full-project recovery scope', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  await assert.rejects(createSnapshot({
    project: f.project, destination: path.join(f.root, 'staging'), id: 'partial',
    ...scope, files: ['app'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  }), /scope|inventory/i);
  await assert.rejects(readFile(path.join(f.root, 'staging', 'complete.json')), { code: 'ENOENT' });
});

test('full-project capture checks new top-level files even without a caller source check', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  await f.file('new-assets/model');
  await assert.rejects(createSnapshot({
    project: f.project, destination: path.join(f.root, 'staging'), id: 'late',
    ...scope, source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  }), /scope|inventory/i);
});

test('new configuration after scope observation is not captured as formerly absent', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  await f.file('.env.production.local', 'new configuration');
  await assert.rejects(createSnapshot({
    project: f.project, destination: path.join(f.root, 'staging'), id: 'changed', ...scope,
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  }), /absent|scope|changed/i);
});

test('project scope recheck rejects new top-level runtime assets instead of omitting them', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  await f.file('new-assets/model.bin');
  await assert.rejects(scope.check(), /scope|changed/i);
});

for (const marker of ['.git/config', '.git']) {
  test(`nested repository/worktree is refused, not recursively captured: ${marker}`, async t => {
    const f = await installation(t);
    await f.file(`nested/${marker}`, 'gitdir: ../other');
    await assert.rejects(inspectSnapshotScope({ project: f.project }), /nested|repository|worktree/i);
  });
}

test('snapshot absence metadata cannot overlap stored files or their ancestors', async t => {
  const f = await installation(t);
  for (const absentPaths of [['app'], ['app/page.tsx'], ['app/page.tsx/child'], ['../escape']]) {
    await assert.rejects(createSnapshot({
      project: f.project, destination: path.join(f.root, 'staging'), id: 'invalid',
      files: ['app'], absentPaths,
      source: { commit: 'a'.repeat(40), provenance: 'observed' },
      runtime: { platform: process.platform, state: 'stopped' },
    }));
  }
});

test('verification refuses extra cached content even when it was excluded from the original scope', async t => {
  const f = await installation(t);
  const scope = await inspectSnapshotScope({ project: f.project });
  const destination = path.join(f.root, 'staging');
  await createSnapshot({
    project: f.project, destination, id: 'excluded', ...scope,
    source: { commit: 'a'.repeat(40), provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  await mkdir(path.join(destination, 'files', '.next', 'cache'));
  await writeFile(path.join(destination, 'files', '.next', 'cache', 'foreign'), 'do not ignore');
  await assert.rejects(verifySnapshot(destination), /inventory|integrity/i);
});

test('special permission bits are refused before snapshot copying rather than silently lost', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await installation(t);
  await chmod(path.join(f.project, 'app', 'page.tsx'), 0o2755);
  await assert.rejects(inspectSnapshotScope({ project: f.project }), /permission|mode/i);
});

test('links to deliberately excluded logs cannot silently create an incomplete backup', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await installation(t);
  await symlink('logs/app.log', path.join(f.project, 'runtime-log-link'));
  await assert.rejects(inspectSnapshotScope({ project: f.project }), /target not captured/i);
});
