import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectGitMetadata } from '../scripts/deployment/git-metadata.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { restoreGitMetadata } from '../scripts/deployment/restore-git.mjs';

const execute = promisify(execFile);
async function git(project, ...args) {
  return (await execute('git', ['-C', project, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'source with spaces');
  await mkdir(project);
  await git(project, 'init', '--initial-branch=main');
  await git(project, 'config', 'user.name', 'Deployment fixture');
  await git(project, 'config', 'user.email', 'fixture@example.invalid');
  await git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'app.txt'), 'original\n');
  await git(project, 'add', 'app.txt');
  await git(project, 'commit', '-m', 'original');
  return { root, project, commit: await git(project, 'rev-parse', 'HEAD') };
}

test('Git metadata capture pins exact HEAD/index and resolved source without refreshing the index', async t => {
  const f = await fixture(t);
  const indexPath = path.join(f.project, '.git/index');
  const index = await readFile(indexPath);
  const head = await readFile(path.join(f.project, '.git/HEAD'));
  const captured = await inspectGitMetadata({ project: f.project, commit: f.commit });
  assert.equal(captured.record.version, 1);
  assert.equal(captured.record.commit, f.commit);
  assert.equal(captured.record.ref, 'refs/heads/main');
  assert.deepEqual(Buffer.from(captured.record.head, 'base64'), head);
  assert.deepEqual(Buffer.from(captured.record.index, 'base64'), index);
  assert.deepEqual(await readFile(indexPath), index);
  await captured.check();
  await writeFile(indexPath, Buffer.concat([index, Buffer.from('foreign')]));
  await assert.rejects(captured.check(), /metadata|index|changed/i);
});

test('Git metadata supports detached and packed HEAD references but refuses stale commit identity', async t => {
  const f = await fixture(t);
  await git(f.project, 'pack-refs', '--all');
  const packed = await inspectGitMetadata({ project: f.project, commit: f.commit });
  assert.equal(packed.record.ref, 'refs/heads/main');
  await packed.check();
  await git(f.project, 'switch', '--detach', f.commit);
  await assert.rejects(packed.check(), /metadata|HEAD|changed/i);
  const detached = await inspectGitMetadata({ project: f.project, commit: f.commit });
  assert.equal(detached.record.ref, null);
  await detached.check();
  await assert.rejects(inspectGitMetadata({ project: f.project, commit: '0'.repeat(40) }), /commit|source/i);
});

test('Git metadata refuses shared-worktree and locked-index layouts without writing them', async t => {
  const f = await fixture(t);
  const lock = path.join(f.project, '.git/index.lock');
  await writeFile(lock, 'other writer');
  await assert.rejects(inspectGitMetadata({ project: f.project, commit: f.commit }), /lock|writer/i);
  assert.equal(await readFile(lock, 'utf8'), 'other writer');
  const worktree = path.join(f.root, 'linked');
  await git(f.project, 'worktree', 'add', '--detach', worktree, f.commit);
  const pointer = await readFile(path.join(worktree, '.git'));
  await assert.rejects(inspectGitMetadata({ project: worktree, commit: f.commit }), /standalone|directory|worktree/i);
  assert.deepEqual(await readFile(path.join(worktree, '.git')), pointer);
});

test('complete snapshots bind exact Git metadata and detect payload tampering without including the Git tree', async t => {
  const f = await fixture(t);
  const gitMetadata = await inspectGitMetadata({ project: f.project, commit: f.commit });
  const scope = await inspectSnapshotScope({ project: f.project });
  const destination = path.join(f.root, 'backup');
  const snapshot = await createSnapshot({
    project: f.project, destination, id: 'git-source', ...scope, gitMetadata,
    source: { commit: f.commit, provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  });
  assert.equal(snapshot.gitMetadata.version, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'git.json'), 'utf8')), gitMetadata.record);
  assert.equal(snapshot.entries.some(entry => entry.path === '.git' || entry.path.startsWith('.git/')), false);
  await verifySnapshot(destination);
  await writeFile(path.join(destination, 'git.json'), '{}');
  await assert.rejects(verifySnapshot(destination), /Git|metadata|checksum|integrity/i);
});

test('a source change after Git observation cannot complete a snapshot of mismatched provenance', async t => {
  const f = await fixture(t);
  const gitMetadata = await inspectGitMetadata({ project: f.project, commit: f.commit });
  await git(f.project, 'switch', '--detach', f.commit);
  const destination = path.join(f.root, 'backup');
  await assert.rejects(createSnapshot({
    project: f.project, destination, id: 'changed-git',
    ...await inspectSnapshotScope({ project: f.project }), gitMetadata,
    source: { commit: f.commit, provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
  }), /metadata|HEAD|changed/i);
  await assert.rejects(readFile(path.join(destination, 'complete.json')), { code: 'ENOENT' });
});

test('Git restoration resets only saved HEAD/index/ref under stopped authority, without checkout or build', async t => {
  const f = await fixture(t);
  const metadata = await inspectGitMetadata({ project: f.project, commit: f.commit });
  await writeFile(path.join(f.project, 'app.txt'), 'updated\n');
  await git(f.project, 'commit', '-am', 'updated');
  const next = await git(f.project, 'rev-parse', 'HEAD');
  const config = await readFile(path.join(f.project, '.git/config'));
  await assert.rejects(restoreGitMetadata({ project: f.project, record: metadata.record,
    checkStopped: async () => ({ stopped: false, inhibited: true }) }), /stopped|inhibited/i);
  assert.equal(await git(f.project, 'rev-parse', 'HEAD'), next);
  await restoreGitMetadata({ project: f.project, record: metadata.record,
    checkStopped: async () => ({ stopped: true, inhibited: true }) });
  assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.commit);
  assert.equal(await git(f.project, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.deepEqual(await readFile(path.join(f.project, '.git/index')), Buffer.from(metadata.record.index, 'base64'));
  assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'updated\n');
  assert.deepEqual(await readFile(path.join(f.project, '.git/config')), config);
  await restoreGitMetadata({ project: f.project, record: metadata.record,
    checkStopped: async () => ({ stopped: true, inhibited: true }) });
});
