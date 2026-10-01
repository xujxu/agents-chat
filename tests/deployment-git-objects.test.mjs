import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectGitMetadata } from '../scripts/deployment/git-metadata.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { restoreProjectSnapshot } from '../scripts/deployment/restore-project.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'source');
  const backup = path.join(root, 'backup');
  await mkdir(project);
  const git = async (...args) => (await execute('git', ['-C', project, ...args],
    { timeout: 20000, maxBuffer: 16384 })).stdout.trim();
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Deployment fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'source.txt'), 'original source\n');
  await git('add', 'source.txt');
  await git('commit', '-m', 'original');
  await git('repack', '-ad');
  t.diagnostic(`Git object auxiliary inventory: ${(await readdir(path.join(project, '.git/objects/info'))).join(', ')}`);
  const commit = await git('rev-parse', 'HEAD');
  const snapshot = () => createSnapshot({
    project, destination: backup, id: 'git-objects', source: { commit, provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
    ...scope, gitMetadata,
  });
  const scope = await inspectSnapshotScope({ project });
  const gitMetadata = await inspectGitMetadata({ project, commit });
  return { root, project, backup, git, commit, snapshot };
}

test('complete Git snapshots bind packed object bytes as well as HEAD/index', async t => {
  const f = await fixture(t);
  const manifest = await f.snapshot();
  assert.equal(manifest.gitObjects.version, 1);
  assert.match(manifest.gitObjects.sha256, /^[a-f0-9]{64}$/);
  const objects = path.join(f.backup, 'git-objects/files/pack');
  const pack = (await readdir(objects)).find(name => name.endsWith('.pack'));
  assert.ok(pack);
  await writeFile(path.join(objects, pack), 'corrupt packed object payload');
  await assert.rejects(verifySnapshot(f.backup), /integrity|checksum|size|changed/i);
});

test('external object alternates are refused instead of producing a falsely self-contained Git backup', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, '.git/objects/info/alternates'), '/unavailable-object-store\n');
  await assert.rejects(f.snapshot(), /object|alternate|unsupported/i);
});

for (const [before, after] of [
  ['split', 'split'], ['split', 'single'], ['single', 'split'], ['absent', 'split'], ['absent', 'single'],
]) {
  test(`Linux Git graph metadata restores ${before} layout after ${after} history growth`, {
    skip: process.platform !== 'linux' || process.getuid() !== 0,
  }, async t => {
    const f = await fixture(t);
    const pointers = ['info/commit-graph', 'info/commit-graphs/commit-graph-chain'];
    const pointer = name => path.join(f.project, '.git/objects', name);
    const graph = mode => f.git('commit-graph', 'write', '--reachable',
      ...(mode === 'split' ? ['--split=no-merge'] : []));
    if (before !== 'absent') await graph(before);
    const original = await Promise.all(pointers.map(async name => {
      try { return await readFile(pointer(name)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    const manifest = await f.snapshot();
    await writeFile(path.join(f.project, 'source.txt'), 'later graph source\n');
    await f.git('commit', '-am', 'later graph');
    const later = await f.git('rev-parse', 'HEAD');
    await graph(after);
    await restoreProjectSnapshot({
      project: f.project, backup: f.backup, acceptDataLoss: true, expectedSnapshot: manifest,
      checkStopped: async () => ({ stopped: true, inhibited: true }),
    });
    for (const [index, name] of pointers.entries()) {
      if (original[index] === null) await assert.rejects(lstat(pointer(name)), { code: 'ENOENT' });
      else assert.deepEqual(await readFile(pointer(name)), original[index]);
    }
    assert.equal(await f.git('rev-parse', 'HEAD'), f.commit);
    assert.equal(await f.git('show', 'HEAD:source.txt'), 'original source');
    assert.equal(await f.git('show', `${later}:source.txt`), 'later graph source');
    await f.git('commit-graph', 'verify');
    await f.git('fsck', '--full', '--no-reflogs');
    assert.deepEqual(await verifySnapshot(f.backup), manifest);
  });
}

for (const boundary of ['partial', 'hardlink']) {
  test(`Linux Git graph metadata restoration handles ${boundary} pointer evidence`, {
    skip: process.platform !== 'linux' || process.getuid() !== 0,
  }, async t => {
    const f = await fixture(t);
    await f.git('commit-graph', 'write', '--reachable', '--split');
    const chain = path.join(f.project, '.git/objects/info/commit-graphs/commit-graph-chain');
    const original = await readFile(chain);
    const manifest = await f.snapshot();
    const foreign = path.join(f.root, 'retained graph hardlink');
    if (boundary === 'hardlink') await link(chain, foreign);
    else {
      await chmod(chain, 0o600);
      await writeFile(chain, 'partial graph pointer');
    }
    const restore = () => restoreProjectSnapshot({
      project: f.project, backup: f.backup, acceptDataLoss: true, expectedSnapshot: manifest,
      checkStopped: async () => ({ stopped: true, inhibited: true }),
    });
    if (boundary === 'hardlink') {
      await assert.rejects(restore(), /graph metadata.*links/i);
      assert.deepEqual(await readFile(foreign), original);
      assert.equal((await lstat(chain)).nlink, 2);
    } else {
      await restore();
      assert.deepEqual(await readFile(chain), original);
      await f.git('commit-graph', 'verify');
    }
    assert.deepEqual(await verifySnapshot(f.backup), manifest);
  });
}

for (const name of ['commit-graph-chain.lock', 'foreign.graph']) {
  test(`Git graph entry ${name} remains refused`, async t => {
    const f = await fixture(t);
    await f.git('commit-graph', 'write', '--reachable', '--split');
    const directory = path.join(f.project, '.git/objects/info/commit-graphs');
    const file = path.join(directory, name);
    await writeFile(file, 'retain this evidence');
    await assert.rejects(f.snapshot(), /object|unsupported|writer/i);
    assert.equal(await readFile(file, 'utf8'), 'retain this evidence');
  });
}

test('Linux source recovery restores missing packed objects offline while preserving newer loose objects', {
  skip: process.platform !== 'linux',
}, async t => {
  const f = await fixture(t);
  const manifest = await f.snapshot();
  await writeFile(path.join(f.project, 'source.txt'), 'later source\n');
  await f.git('commit', '-am', 'later');
  const later = await f.git('rev-parse', 'HEAD');
  await rm(path.join(f.project, '.git/objects/pack'), { recursive: true });
  await assert.rejects(f.git('cat-file', '-e', `${f.commit}^{commit}`));
  await restoreProjectSnapshot({
    project: f.project, backup: f.backup, acceptDataLoss: true, expectedSnapshot: manifest,
    checkStopped: async () => ({ stopped: true, inhibited: true }),
  });
  assert.equal(await f.git('rev-parse', 'HEAD'), f.commit);
  assert.equal(await f.git('show', 'HEAD:source.txt'), 'original source');
  assert.equal(await f.git('show', `${later}:source.txt`), 'later source');
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'original source\n');
  await f.git('fsck', '--full', '--no-reflogs');
  assert.deepEqual(await verifySnapshot(f.backup), manifest);
});

for (const boundary of ['staged', 'linked', 'partial', 'conflict', 'alternate']) {
  test(`Linux object publication reentry classifies ${boundary} evidence before restoring HEAD`, {
    skip: process.platform !== 'linux',
  }, async t => {
    const f = await fixture(t);
    const manifest = await f.snapshot();
    await writeFile(path.join(f.project, 'source.txt'), 'later source\n');
    await f.git('commit', '-am', 'later');
    const later = await f.git('rev-parse', 'HEAD');
    const packed = path.join(f.project, '.git/objects/pack');
    await rm(packed, { recursive: true });
    await mkdir(packed);
    const saved = path.join(f.backup, 'git-objects/files/pack');
    const name = (await readdir(saved)).find(name => name.endsWith('.pack'));
    const target = path.join(packed, name);
    const stage = `${target}.agents-chat-restore`;
    if (boundary === 'alternate') await writeFile(path.join(f.project, '.git/objects/info/alternates'), '/foreign-store\n');
    else if (boundary === 'partial') await writeFile(stage, 'partial');
    else if (boundary === 'conflict') await writeFile(target, 'foreign existing object');
    else {
      await copyFile(path.join(saved, name), stage);
      if (boundary === 'linked') await link(stage, target);
    }
    const restore = () => restoreProjectSnapshot({
      project: f.project, backup: f.backup, acceptDataLoss: true, expectedSnapshot: manifest,
      checkStopped: async () => ({ stopped: true, inhibited: true }),
    });
    if (['partial', 'conflict', 'alternate'].includes(boundary)) {
      await assert.rejects(restore(), /object|staged|publication/i);
      assert.equal(await f.git('rev-parse', 'HEAD'), later);
      const evidence = boundary === 'alternate' ? path.join(f.project, '.git/objects/info/alternates')
        : boundary === 'partial' ? stage : target;
      assert.equal(await readFile(evidence, 'utf8'), boundary === 'alternate' ? '/foreign-store\n'
        : boundary === 'partial' ? 'partial' : 'foreign existing object');
      assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'later source\n');
    } else {
      await restore();
      assert.equal(await f.git('show', 'HEAD:source.txt'), 'original source');
      assert.equal((await readdir(packed)).some(name => name.endsWith('.agents-chat-restore')), false);
      await f.git('fsck', '--full', '--no-reflogs');
    }
    assert.deepEqual(await verifySnapshot(f.backup), manifest);
  });
}
