import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { freshSourceInstallationFixture, removeFirstSourceUnit } from './deployment-linux-first-source-fixture.mjs';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';
import { loadState, releaseLock } from '../scripts/deployment/state.mjs';
import { readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';
import { waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const execute = promisify(execFile);
const tools = fileURLToPath(new URL('../', import.meta.url));

test('public fresh installation survives two updates and restores the retained source and application data', {
  skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_LIFECYCLE !== '1',
}, async t => {
  const uid = Number((await execute('/usr/bin/id', ['-u', 'agents-chat-test'])).stdout.trim());
  const gid = Number((await execute('/usr/bin/id', ['-g', 'agents-chat-test'])).stdout.trim());
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  const f = await freshSourceInstallationFixture(t, { unit: 'agents-chat.service', uid, gid });
  const { unit, executables } = f.installation.identity;
  const native = { unit, project: f.project, npm: executables[0].file, node: executables[1].file };
  const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/root', NODE_ENV: 'development' };
  const git = async (...args) => (await execute('/usr/bin/git', [
    '-c', 'user.name=Deployment fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', f.project, ...args,
  ], { uid, gid, env: { PATH: environment.PATH, HOME: f.home }, timeout: 60000, maxBuffer: 16384 })).stdout.trim();
  const invoke = async (operation, args, source = f.project) => {
    const { stdout, stderr } = await execute('/usr/bin/bash', [
      path.join(source, `scripts/${operation}.sh`), '--project-dir', f.project, '--json', ...args,
    ], { cwd: '/', env: environment, timeout: 660000, maxBuffer: 16384 });
    assert.doesNotMatch(stderr, /cleanup failed/);
    return JSON.parse(stdout);
  };
  const observe = async () => {
    const service = await inspectLinuxService(native);
    try {
      await waitLinuxReadiness({ service, port: 3010, providers: ['admin-login'] });
      assert.equal(service.identity.runtime.uid, uid);
      assert.equal((await linuxSystemdProperties(unit, ['UnitFileState'])).UnitFileState, 'enabled');
      await service.check();
      return service.identity;
    } finally { await service.close(); }
  };
  try {
    await releaseLock(f.control, f.lock);
    await rmdir(f.control);
    const dotenv = path.join(f.project, '.env.local');
    await writeFile(dotenv, `${await readFile(dotenv, 'utf8')}npm_config_cache=${path.join(f.home, '.npm')}\n`);
    const initial = await git('rev-parse', 'HEAD');
    const readme = path.join(f.project, 'README.md');
    const originalReadme = await readFile(readme, 'utf8');
    const secondReadme = `${originalReadme}\nFixture source version: first update.\n`;
    const thirdReadme = `${originalReadme}\nFixture source version: second update.\n`;
    const revision = async (bytes, message) => {
      await writeFile(readme, bytes);
      await git('add', '--', 'README.md');
      await git('commit', '--quiet', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const second = await revision(secondReadme, 'First public update');
    const third = await revision(thirdReadme, 'Second public update');
    assert.equal(new Set([initial, second, third]).size, 3);
    await git('checkout', '--quiet', '--detach', initial);
    assert.equal(await readFile(readme, 'utf8'), originalReadme);

    assert.deepEqual(await invoke('deploy', ['--no-pull', '--timeout', '600']),
      { status: 'accepted', backupCreated: false });
    const firstService = await observe();
    const firstReceipt = await readDeploymentReceipt(f.control, f.project);
    assert.equal(firstReceipt.identity.source, initial);
    assert.deepEqual((await readdir(f.control)).sort(), ['deployment.json', 'recovery-engine', 'state.json']);
    const api = await loginDeploymentFixture({ password: 'fresh-build-private-password' });
    const chatId = `fresh-lifecycle-${randomUUID()}`;
    const chat = { id: chatId, name: 'Before first update', ts: Date.now(), agentSessions: {},
      messages: [{ id: 'original', type: 'user', content: 'Retained across public lifecycle', ts: Date.now() }] };
    assert.equal((await api('/api/chats', { chat })).ok, true);
    assert.deepEqual(await invoke('update', ['--no-pull', '--timeout', '600']),
      { status: 'already-current', backupCreated: false });
    assert.deepEqual(await observe(), firstService);
    assert.deepEqual(await readDeploymentReceipt(f.control, f.project), firstReceipt);
    assert.deepEqual((await readdir(f.control)).sort(), ['deployment.json', 'recovery-engine', 'state.json']);

    assert.deepEqual(await invoke('update', ['--revision', second, '--timeout', '600']),
      { status: 'accepted', backupCreated: true });
    await observe();
    const backupDirectory = path.join(f.control, 'backup');
    const firstBackup = await verifySnapshot(backupDirectory);
    assert.equal(firstBackup.source.commit, initial);
    const secondBuild = await readFile(path.join(f.project, '.next/BUILD_ID'));
    assert.equal(await readFile(readme, 'utf8'), secondReadme);
    assert.equal((await readDeploymentReceipt(f.control, f.project)).identity.source, second);
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, 'Before first update');
    assert.equal((await api('/api/chats', { action: 'rename', chatId, name: 'Before second update' })).ok, true);

    assert.deepEqual(await invoke('update', ['--revision', third, '--timeout', '600']),
      { status: 'accepted', backupCreated: true });
    await observe();
    const backup = await verifySnapshot(backupDirectory);
    assert.notEqual(backup.id, firstBackup.id);
    assert.equal(backup.source.commit, second);
    assert.deepEqual(await readFile(path.join(backupDirectory, 'files/.next/BUILD_ID')), secondBuild);
    const receipt = await readDeploymentReceipt(f.control, f.project);
    assert.equal(receipt.identity.source, third);
    assert.equal(await readFile(readme, 'utf8'), thirdReadme);
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, 'Before second update');
    assert.equal((await api('/api/chats', { action: 'rename', chatId, name: 'After second update' })).ok, true);
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, 'After second update');

    await rename(path.join(f.project, 'scripts'), path.join(f.root, 'displaced checkout scripts'));
    await rm(path.join(f.project, '.git/objects/pack'), { recursive: true });
    assert.deepEqual(await invoke('restore', ['--accept-data-loss', '--timeout', '600'], tools),
      { status: 'restored', backupId: backup.id });
    await observe();
    assert.equal(await git('rev-parse', 'HEAD'), second);
    assert.equal(await readFile(readme, 'utf8'), secondReadme);
    assert.deepEqual(await readFile(path.join(f.project, '.next/BUILD_ID')), secondBuild);
    const restoredChat = (await api(`/api/chats?id=${chatId}`)).chat;
    assert.equal(restoredChat.name, 'Before second update');
    assert.equal(restoredChat.messages[0].content, 'Retained across public lifecycle');
    assert.equal((await loadState(f.control)).phase, 'restored');
    assert.deepEqual(await verifySnapshot(backupDirectory), backup);
    assert.deepEqual(await readDeploymentReceipt(f.control, f.project), receipt);
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
  } finally {
    await removeFirstSourceUnit(f);
  }
});
