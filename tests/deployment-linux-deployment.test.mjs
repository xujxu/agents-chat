import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chown, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { fixture, ready, node } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { acquireLock, loadState } from '../scripts/deployment/state.mjs';
import { runLinuxLiveDeployment } from '../scripts/deployment/linux-deployment.mjs';
import { readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const settings = `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=private-fixture-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=private-fixture-password`;

async function installation(t) {
  const f = await fixture(t, { nonroot: true, settings, server: `
const fs = require('node:fs');
require('node:http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ credentials: { id: 'credentials', name: 'Credentials', type: 'credentials',
    signinUrl: 'http://localhost:3010/api/auth/signin/credentials',
    callbackUrl: 'http://localhost:3010/api/auth/callback/credentials' } }));
}).listen(3010, '127.0.0.1', () => fs.writeFileSync('ready', String(process.pid)));
` });
  await ready(f);
  const git = async (...args) => (await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`,
    '-C', f.project, ...args], { timeout: 60000, maxBuffer: 16384 })).stdout.trim();
  await git('init', '--initial-branch=fixture');
  await git('config', 'user.name', 'Deployment fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(f.project, '.git/info/exclude'), 'ready\n.npm/\n');
  await git('add', 'package.json', 'server.cjs');
  await git('commit', '-m', 'prior fixture source');
  const prior = await git('rev-parse', 'HEAD');
  await git('fetch', '--quiet', repository, 'HEAD');
  const target = await git('rev-parse', 'FETCH_HEAD');
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
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project });
  const environment = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: service.identity.runtime.home,
    USER: 'nobody', LOGNAME: 'nobody', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NEXTAUTH_SECRET: 'private-fixture-secret', NEXTAUTH_URL: 'http://localhost:3010',
    ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password',
    npm_config_cache: path.join(f.project, '.npm'),
  };
  return { ...f, service, control, lock, git: '/usr/bin/git', environment,
    port: 3010, prior, target, deploymentBytes: 2 * 1024 ** 3 };
}

test('native deployment refuses unsupported target before downtime and releases settled preflight', async t => {
  const f = await installation(t);
  await assert.rejects(runLinuxLiveDeployment({ ...f, revision: f.prior }),
    { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
  assert.equal((await loadState(f.control)).phase, 'preflight-refused');
  assert.equal((await f.service.check()).populated, true);
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
  await waitLinuxReadiness({ service: active, port: 3010, providers: ['credentials'] });
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

test('native deployment composes snapshot, real application build, owned activation and accepted receipt', {
  skip: process.env.DEPLOYMENT_TEST_REAL_DEPLOYMENT !== '1',
}, async t => {
  const f = await installation(t);
  const result = await runLinuxLiveDeployment({ ...f, revision: f.target, timeoutSeconds: 600 });
  assert.equal(result.status, 'accepted');
  assert.equal(result.backupCreated, true);
  const state = await loadState(f.control);
  assert.equal(state.phase, 'accepted');
  const receipt = await readDeploymentReceipt(f.control, f.project);
  assert.equal(receipt.identity.source, f.target);
  const backup = await verifySnapshot(path.join(f.control, 'backup'));
  assert.equal(backup.source.commit, f.prior);
  assert.equal(await readFile(path.join(f.control, 'backup/files/server.cjs'), 'utf8'),
    (await execute('/usr/bin/git', ['-c', `safe.directory=${f.project}`, '-C', f.project,
      'show', `${f.prior}:server.cjs`])).stdout);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'deployment.json', 'recovery-engine', 'state.json']);
  await saveRecoveryEngine({ source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), control: f.control });
});
