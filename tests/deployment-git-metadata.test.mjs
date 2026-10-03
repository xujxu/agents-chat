import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectGitMetadata, readGitMetadataFile, validateGitMetadata } from '../scripts/deployment/git-metadata.mjs';
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

test('Git file identities preserve all bits above the JavaScript safe integer range', async t => {
  const f = await fixture(t);
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  const exact = 9007199254740993n;
  const withIdentity = info => {
    info.ino = typeof info.ino === 'bigint' ? exact : Number(exact);
    return info;
  };
  t.mock.method(fs, 'lstat', async (...args) => withIdentity(await originalLstat(...args)));
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalStat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async (...options) => withIdentity(await originalStat(...options)));
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const descriptor = await readGitMetadataFile(path.join(f.project, '.git/index'), 16 * 1024 * 1024);
    assert.equal(descriptor.ino, exact.toString());
    assert.notEqual(descriptor.ino, String(Number(exact)));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('Git metadata capture pins exact HEAD/index and resolved source without refreshing the index', async t => {
  const f = await fixture(t);
  const indexPath = path.join(f.project, '.git/index');
  const index = await readFile(indexPath);
  const info = await lstat(indexPath, { bigint: true });
  const descriptor = await readGitMetadataFile(indexPath, 16 * 1024 * 1024);
  assert.equal(descriptor.dev, String(info.dev));
  assert.equal(descriptor.ino, String(info.ino));
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

test('Windows Git metadata codec requires exact security coverage and consistent explicit absence', async t => {
  const f = await fixture(t);
  const { record: base } = await inspectGitMetadata(f);
  const record = {
    ...base, version: 2, absentPaths: [],
    windowsSecurity: {
      version: 1, descriptors: ['O:SYG:SYD:(A;OICI;FA;;;SY)'], root: { security: 0, attributes: 16 },
      entries: ['HEAD', 'index', 'refs', 'refs/heads', base.ref].map(name => ({
        path: name, security: 0, attributes: ['refs', 'refs/heads'].includes(name) ? 16 : 128,
      })),
    },
  };
  assert.deepEqual(validateGitMetadata(record, f.commit), record);
  const packed = structuredClone(record);
  packed.absentPaths = [base.ref];
  packed.windowsSecurity.entries.pop();
  assert.deepEqual(validateGitMetadata(packed, f.commit), packed);
  const missingParents = structuredClone(record);
  missingParents.absentPaths = ['refs', 'refs/heads', base.ref];
  missingParents.windowsSecurity.entries = missingParents.windowsSecurity.entries.slice(0, 2);
  assert.deepEqual(validateGitMetadata(missingParents, f.commit), missingParents);
  for (const change of [
    value => { value.absentPaths = ['HEAD']; },
    value => { value.absentPaths = ['config']; },
    value => { value.absentPaths = ['refs/heads']; },
    value => { value.absentPaths = [base.ref, base.ref]; },
    value => { value.windowsSecurity.entries[0].path = 'config'; },
    value => { value.windowsSecurity.entries[0].attributes = 16; },
    value => { value.windowsSecurity.extra = true; },
    value => { delete value.windowsSecurity; },
    value => { value.version = 1; },
  ]) {
    const invalid = structuredClone(record);
    change(invalid);
    assert.throws(() => validateGitMetadata(invalid, f.commit), /Git|snapshot|security|field|path|absen/i);
  }
});

test('retained Git metadata accepts fresh stage signals but never ignores cancellation', async t => {
  const f = await fixture(t);
  const initial = new AbortController();
  const captured = await inspectGitMetadata({ ...f, signal: initial.signal });
  initial.abort(new Error('capture stage cancelled'));
  await assert.rejects(captured.check(), /capture stage cancelled/);
  const next = new AbortController();
  await captured.check({ signal: next.signal });
  next.abort(new Error('acceptance cancelled'));
  await assert.rejects(captured.check({ signal: next.signal }), /acceptance cancelled/);
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
  const saved = JSON.parse(await readFile(path.join(destination, 'git.json'), 'utf8'));
  if (process.platform === 'win32') {
    const { windowsSecurity, absentPaths, ...base } = saved;
    assert.equal(saved.version, 2);
    assert.ok(windowsSecurity);
    assert.deepEqual(absentPaths, []);
    assert.deepEqual({ ...base, version: 1 }, gitMetadata.record);
  } else assert.deepEqual(saved, gitMetadata.record);
  assert.equal(snapshot.entries.some(entry => entry.path === '.git' || entry.path.startsWith('.git/')), false);
  await verifySnapshot(destination);
  await writeFile(path.join(destination, 'git.json'), '{}');
  await assert.rejects(verifySnapshot(destination), /Git|metadata|checksum|integrity/i);
});

for (const layout of ['attached', 'packed', 'detached']) {
  test(`Windows ${layout} Git snapshots retain native metadata permissions and explicit absence`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const f = await fixture(t);
    if (layout === 'packed') await git(f.project, 'pack-refs', '--all');
    if (layout === 'detached') await git(f.project, 'switch', '--detach', f.commit);
    const indexPath = path.join(f.project, '.git/index');
    await chmod(indexPath, 0o400);
    const originalIndex = await readFile(indexPath);
    const gitMetadata = await inspectGitMetadata({ project: f.project, commit: f.commit });
    const destination = path.join(f.root, 'backup');
    const manifest = await createSnapshot({
      project: f.project, destination, id: 'git-security', gitMetadata,
      ...await inspectSnapshotScope({ project: f.project }),
      source: { commit: f.commit, provenance: 'observed' },
      runtime: { platform: process.platform, state: 'stopped' },
    });
    const record = JSON.parse(await readFile(path.join(destination, 'git.json'), 'utf8'));
    assert.equal(record.version, 2);
    assert.deepEqual(Buffer.from(record.index, 'base64'), originalIndex);
    const index = record.windowsSecurity.entries.find(entry => entry.path === 'index');
    assert.ok(index);
    assert.equal(index.attributes & 1, 1);
    assert.equal(record.absentPaths.includes('refs/heads/main'), layout === 'packed');
    assert.equal(record.ref, layout === 'detached' ? null : 'refs/heads/main');
    assert.deepEqual(await readFile(indexPath), originalIndex);
    assert.deepEqual(await verifySnapshot(destination), manifest);
    await assert.rejects(restoreGitMetadata({
      project: f.project, record, checkStopped: async () => ({ stopped: true, inhibited: true }),
    }), /native security journal adapter/i);
    await assert.rejects(lstat(path.join(f.project, '.git/agents-chat-restore')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(f.project, '.git/HEAD')), Buffer.from(record.head, 'base64'));
    assert.deepEqual(await readFile(indexPath), originalIndex);
  });
}

test('Windows Git index ACL drift cannot complete an otherwise unchanged project snapshot', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  const gitMetadata = await inspectGitMetadata(f);
  const destination = path.join(f.root, 'backup');
  const indexPath = path.join(f.project, '.git/index');
  const index = await readFile(indexPath);
  let checks = 0;
  await assert.rejects(createSnapshot({
    project: f.project, destination, id: 'git-acl-drift', gitMetadata,
    ...await inspectSnapshotScope({ project: f.project }),
    source: { commit: f.commit, provenance: 'observed' },
    runtime: { platform: process.platform, state: 'stopped' },
    checkSource: async () => {
      if (++checks === 2) {
        await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
          fileURLToPath(new URL('./deployment-windows-snapshot-security-fixture.ps1', import.meta.url)),
          '-File', indexPath, '-Action', 'broaden-git-index'], { timeout: 30000, maxBuffer: 65536 });
      }
    },
  }), error => /ACL|security|changed/i.test(error.cause?.message ?? error.message));
  assert.equal(checks, 2);
  assert.deepEqual(await readFile(indexPath), index);
  await assert.rejects(readFile(path.join(destination, 'complete.json')), { code: 'ENOENT' });
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

for (const pause of ['refs/heads/main', 'index', 'HEAD']) {
  test(`Git metadata publication resumes after controller death following ${pause}`, async t => {
    const f = await fixture(t);
    const { record } = await inspectGitMetadata({ project: f.project, commit: f.commit });
    const saved = path.join(f.root, 'git.json');
    await writeFile(saved, JSON.stringify(record));
    await writeFile(path.join(f.project, 'app.txt'), 'new version\n');
    await git(f.project, 'commit', '-am', 'new');
    const child = fork(new URL('./deployment-git-restore-child.mjs', import.meta.url),
      [f.project, saved, pause], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Git restore did not pause: ${diagnostic}`)), 30000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Git restore exited ${code}: ${diagnostic}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const options = { project: f.project, record, checkStopped: async () => ({ stopped: true, inhibited: true }) };
    const proof = JSON.parse(await readFile(path.join(f.project, '.git/agents-chat-restore/intent.json'), 'utf8'));
    for (const entry of proof.entries) {
      const published = proof.entries.findIndex(item => item.file === entry.file)
        <= proof.entries.findIndex(item => item.file === pause);
      const info = await lstat(path.join(f.project, '.git', `${entry.file}${published ? '' : '.lock'}`), { bigint: true });
      assert.equal(entry.staged.dev, String(info.dev));
      assert.equal(entry.staged.ino, String(info.ino));
    }
    await assert.rejects(restoreGitMetadata(options), /alive/i);
    child.kill('SIGKILL');
    await exited;
    if (pause === 'index') {
      const target = path.join(f.project, '.git/index');
      const bytes = await readFile(target);
      await rename(target, `${target}.retained`);
      await writeFile(target, bytes);
      await assert.rejects(restoreGitMetadata(options), /changed|identity/i);
      await unlink(target);
      await rename(`${target}.retained`, target);
    }
    await restoreGitMetadata(options);
    assert.equal(await git(f.project, 'rev-parse', 'HEAD'), f.commit);
    assert.deepEqual(await readFile(path.join(f.project, '.git/index')), Buffer.from(record.index, 'base64'));
    assert.equal(await readFile(path.join(f.project, 'app.txt'), 'utf8'), 'new version\n');
    await assert.rejects(readFile(path.join(f.project, '.git/agents-chat-restore/intent.json')), { code: 'ENOENT' });
  });
}
