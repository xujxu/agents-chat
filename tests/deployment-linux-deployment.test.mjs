import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { chown, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { fixture, ready, node, quote } from './deployment-linux-service-fixture.mjs';
import { inspectInstalledLinuxService, inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { acquireLock, loadState } from '../scripts/deployment/state.mjs';
import { runLinuxLiveDeployment } from '../scripts/deployment/linux-deployment.mjs';
import { readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const settings = `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=private-fixture-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=private-fixture-password`;

test('native deployment refuses unsupported command modes without creating control files', async t => {
  const f = await fixture(t);
  await ready(f);
  const { runLinuxUpdateCommand } = await import('../scripts/deployment/linux-update-command.mjs');
  const before = (await readdir(path.dirname(f.project))).sort();
  for (const flags of [['--dry-run'], ['--verify'], ['--wait', '0']]) {
    await assert.rejects(runLinuxUpdateCommand({
      args: ['--project-dir', f.project, ...flags], unit: f.unit,
    }), { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });
  }
  assert.deepEqual((await readdir(path.dirname(f.project))).sort(), before);
});

test('native deployment refuses foreign command state and status never initializes control', async t => {
  const f = await fixture(t);
  await ready(f);
  const { runLinuxUpdateCommand } = await import('../scripts/deployment/linux-update-command.mjs');
  const args = ['--project-dir', f.project, '--status'];
  const control = path.join(path.dirname(f.project), `.${path.basename(f.project)}.deployment`);
  assert.deepEqual(await runLinuxUpdateCommand({ args, unit: f.unit }), {
    status: 'unmanaged', project: f.project, control, phase: null,
  });
  await assert.rejects(readdir(control), { code: 'ENOENT' });
  await mkdir(control, { mode: 0o700 });
  await writeFile(path.join(control, 'foreign-evidence'), 'preserve');
  await assert.rejects(runLinuxUpdateCommand({ args: ['--project-dir', f.project], unit: f.unit }),
    { code: 'DEPLOYMENT_CONTROL_UNBOUND' });
  assert.equal(await readFile(path.join(control, 'foreign-evidence'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(control), ['foreign-evidence']);
});

async function installation(t) {
  const f = await fixture(t, { nonroot: true,
    settings: ({ project }) => `${settings}\nEnvironment=${quote(`npm_config_cache=${path.join(project, '.npm')}`)}`,
    server: `
const fs = require('node:fs');
require('node:http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ 'admin-login': { id: 'admin-login', name: 'Admin', type: 'credentials',
    signinUrl: 'http://localhost:3010/api/auth/signin/admin-login',
    callbackUrl: 'http://localhost:3010/api/auth/callback/admin-login' } }));
}).listen(3010, '127.0.0.1', () => fs.writeFileSync('ready', String(process.pid)));
` });
  await ready(f);
  const git = async (...args) => (await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`,
    '-C', f.project, ...args], { timeout: 60000, maxBuffer: 16384 })).stdout.trim();
  await git('init', '--initial-branch=fixture');
  await git('config', 'user.name', 'Deployment fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(f.project, '.git/info/exclude'), 'ready\n.npm/\n');
  await writeFile(path.join(f.project, 'agents.json'), await readFile(path.join(repository, 'agents.json')));
  await git('add', 'package.json', 'server.cjs', 'agents.json');
  await git('commit', '-m', 'prior fixture source');
  const prior = await git('rev-parse', 'HEAD');
  await git('fetch', '--quiet', repository, 'HEAD');
  const target = await git('rev-parse', 'FETCH_HEAD');
  const nextTarget = await git('commit-tree', `${target}^{tree}`, '-p', target, '-m', 'next deployment fixture revision');
  const own = async directory => {
    await chown(directory, 65534, 65534);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      else if (entry.isFile()) await chown(file, 65534, 65534);
      else throw new Error('Unexpected fixture link.');
    }
  };
  await own(f.project);
  const service = await inspectInstalledLinuxService({ unit: f.unit, project: f.project });
  t.after(() => service.close());
  const control = path.join(path.dirname(f.project), `.${path.basename(f.project)}.deployment`);
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const environment = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: service.identity.runtime.home,
    USER: 'nobody', LOGNAME: 'nobody', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NEXTAUTH_SECRET: 'private-fixture-secret', NEXTAUTH_URL: 'http://localhost:3010',
    ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password',
    npm_config_cache: path.join(f.project, '.npm'),
  };
  return { ...f, service, control, lock, git: '/usr/bin/git', environment,
    port: 3010, prior, target, nextTarget, deploymentBytes: 2 * 1024 ** 3 };
}

test('native deployment refuses unsupported target before downtime and releases settled preflight', async t => {
  const f = await installation(t);
  await assert.rejects(runLinuxLiveDeployment({ ...f, revision: f.prior }),
    { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
  assert.equal((await loadState(f.control)).phase, 'preflight-refused');
  assert.equal((await f.service.check()).populated, true);
  assert.deepEqual((await readdir(f.control)).sort(), ['state.json']);
});

test('native deployment refuses conflicting build environment before downtime', async t => {
  const f = await installation(t);
  await assert.rejects(runLinuxLiveDeployment({
    ...f, revision: f.target, environment: { ...f.environment, NEXTAUTH_SECRET: 'different-private-secret' },
  }), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check: 'build-environment-conflict' });
  assert.equal((await loadState(f.control)).phase, 'preflight-refused');
  await f.service.check();
  assert.deepEqual((await readdir(f.control)).sort(), ['state.json']);
});

test('native deployment restores prior owned runtime after pre-source snapshot rotation failure', async t => {
  const f = await installation(t);
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === path.join(f.control, 'staging') && to === path.join(f.control, 'backup')) {
      throw new Error('fixture rotation publication failure');
    }
    return original(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runLinuxLiveDeployment({ ...f, revision: f.target }), /fixture rotation publication failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal((await loadState(f.control)).phase, 'prior-runtime-restored');
  const active = await inspectLinuxService(f);
  t.after(() => active.close());
  await waitLinuxReadiness({ service: active, port: 3010, providers: ['admin-login'] });
  assert.equal((await verifySnapshot(path.join(f.control, 'staging'))).source.commit, f.prior);
  assert.equal(await readDeploymentReceipt(f.control, f.project), null);
  assert.equal((await readdir(f.control)).includes('lock'), false);
});

test('native deployment retains backup and inhibition after actual dependency installation fails', async t => {
  const f = await installation(t);
  const environment = { ...f.environment, npm_config_cache: path.join(f.control, 'inaccessible-cache') };
  await assert.rejects(runLinuxLiveDeployment({ ...f, environment, revision: f.target }), /worker|exit|command/i);
  const state = await loadState(f.control);
  assert.equal(state.phase, 'recovery-required');
  assert.equal(state.previousPhase, 'dependencies');
  assert.equal((await verifySnapshot(path.join(f.control, 'backup'))).source.commit, f.prior);
  assert.equal(await readDeploymentReceipt(f.control, f.project), null);
  const files = await readdir(f.control);
  assert.ok(files.includes('lock'));
  assert.ok(files.includes('service-stop.ndjson'));
  await assert.rejects(inspectLinuxService(f), /running|inhibit|policy|start|service/i);
});

for (const scenario of ['synthetic', 'current', 'historical', 'rebuild', 'command']) {
test(`native deployment composes real application acceptance and saved restoration (scenario=${scenario})`, {
  skip: process.env.DEPLOYMENT_TEST_REAL_DEPLOYMENT !== '1',
}, async t => {
  const f = await installation(t);
  const secondUpdate = scenario !== 'synthetic';
  const nextRevision = ['historical', 'rebuild'].includes(scenario) ? f.target : f.nextTarget;
  if (scenario === 'historical') f.target = '638c553c62406dbb7e6b5aeb41cdddf4cd6de179';
  const result = await runLinuxLiveDeployment({ ...f, revision: f.target, timeoutSeconds: 600 });
  assert.equal(result.status, 'accepted');
  assert.equal(result.backupCreated, true);
  const state = await loadState(f.control);
  assert.equal(state.phase, 'accepted');
  let receipt = await readDeploymentReceipt(f.control, f.project);
  assert.equal(receipt.identity.source, f.target);
  let backup = await verifySnapshot(path.join(f.control, 'backup'));
  assert.equal(backup.source.commit, f.prior);
  assert.equal(await readFile(path.join(f.control, 'backup/files/server.cjs'), 'utf8'),
    (await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`, '-C', f.project,
      'show', `${f.prior}:server.cjs`])).stdout);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
  let expectedCommit = f.prior;
  const chatId = `deployment-${randomUUID()}`;
  let api;
  if (secondUpdate) {
    api = await loginDeploymentFixture();
    const chat = { id: chatId, name: 'Preserved before second update', ts: Date.now(), agentSessions: {},
      messages: [{ id: 'original', type: 'user', content: 'Data before snapshot', ts: Date.now() }] };
    assert.equal((await api('/api/chats', { chat })).ok, true);
    const before = (await api(`/api/chats?id=${chatId}`)).chat;
    assert.equal(before.messages[0].content, 'Data before snapshot');
    for (let attempt = 0; attempt < 2; attempt++) {
      const service = await inspectLinuxService(f);
      t.after(() => service.close());
      let result;
      if (scenario === 'command') {
        const { runLinuxUpdateCommand } = await import('../scripts/deployment/linux-update-command.mjs');
        result = await runLinuxUpdateCommand({
          args: ['--project-dir', f.project, '--revision', f.target, '--timeout', '600'], unit: f.unit,
        });
      } else {
        const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
        result = await runLinuxLiveDeployment({ ...f, service, lock, revision: f.target, timeoutSeconds: 600 });
      }
      assert.deepEqual(result, { status: 'already-current', backupCreated: false });
      await service.check();
      assert.deepEqual(await readDeploymentReceipt(f.control, f.project), receipt);
      assert.deepEqual(await verifySnapshot(path.join(f.control, 'backup')), backup);
      assert.equal((await loadState(f.control)).phase, 'already-current');
      assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
    }
    const service = await inspectLinuxService(f);
    t.after(() => service.close());
    if (scenario === 'rebuild') {
      for (const directory of ['.next', 'node_modules']) {
        const file = path.join(f.project, directory, 'deployment-altered-artifact');
        await writeFile(file, 'changed after accepted deployment\n');
        await chown(file, 65534, 65534);
      }
    }
    if (scenario === 'command') {
      const { runLinuxUpdateCommand } = await import('../scripts/deployment/linux-update-command.mjs');
      assert.equal((await runLinuxUpdateCommand({
        args: ['--project-dir', f.project, '--revision', nextRevision, '--timeout', '600'], unit: f.unit,
      })).status, 'accepted');
      assert.equal((await runLinuxUpdateCommand({
        args: ['--project-dir', f.project, '--status'], unit: f.unit,
      })).phase, 'accepted');
    } else {
      const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
      assert.equal((await runLinuxLiveDeployment({
        ...f, service, lock, revision: nextRevision, timeoutSeconds: 600,
      })).status, 'accepted');
    }
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.messages[0].content, 'Data before snapshot');
    const oldBackupId = backup.id;
    backup = await verifySnapshot(path.join(f.control, 'backup'));
    assert.notEqual(backup.id, oldBackupId);
    assert.equal(backup.source.commit, f.target);
    receipt = await readDeploymentReceipt(f.control, f.project);
    assert.equal(receipt.identity.source, nextRevision);
    if (scenario === 'rebuild') {
      for (const directory of ['.next', 'node_modules']) {
        await assert.rejects(readFile(path.join(f.project, directory, 'deployment-altered-artifact')), { code: 'ENOENT' });
      }
      const fresh = await inspectLinuxService(f);
      t.after(() => fresh.close());
      assert.notEqual(fresh.identity.runtime.invocationId, service.identity.runtime.invocationId);
    }
    expectedCommit = f.target;
    assert.equal((await api('/api/chats', { action: 'rename', chatId, name: 'After snapshot' })).ok, true);
    assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, 'After snapshot');
    assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
  }
  const saved = await saveRecoveryEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), control: f.control,
  });
  await rm(path.join(f.project, '.git/objects/pack'), { recursive: true });
  const restored = await new Promise((resolve, reject) => {
    const child = execFile(node, [path.join(saved.directory, 'linux-restore-entry.mjs'),
      f.control, saved.manifestSha256, '--accept-data-loss'], {
      cwd: '/', timeout: 660000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Saved restore failed: ${stderr}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ project: f.project, unit: f.unit, npm: f.npm, node: f.node,
      backup: path.join(f.control, 'backup'), port: 3010, waitSeconds: 30, timeoutSeconds: 600 }));
  });
  assert.deepEqual(JSON.parse(restored), { status: 'restored', backupId: backup.id });
  assert.equal((await loadState(f.control)).phase, 'restored');
  assert.equal((await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`, '-C', f.project,
    'rev-parse', 'HEAD'])).stdout.trim(), expectedCommit);
  assert.equal((await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`, '-C', f.project,
    'cat-file', '-t', f.target])).stdout.trim(), 'commit');
  const active = await inspectLinuxService(f);
  t.after(() => active.close());
  await waitLinuxReadiness({ service: active, port: 3010, providers: ['admin-login'] });
  if (secondUpdate) {
    const restoredChat = (await api(`/api/chats?id=${chatId}`)).chat;
    assert.equal(restoredChat.name, 'Preserved before second update');
    assert.equal(restoredChat.messages[0].content, 'Data before snapshot');
  }
  if (scenario === 'rebuild') {
    for (const directory of ['.next', 'node_modules']) {
      assert.equal(await readFile(path.join(f.project, directory, 'deployment-altered-artifact'), 'utf8'),
        'changed after accepted deployment\n');
    }
  }
  assert.deepEqual(await verifySnapshot(path.join(f.control, 'backup')), backup);
  assert.deepEqual(await readDeploymentReceipt(f.control, f.project), receipt);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
});
}
