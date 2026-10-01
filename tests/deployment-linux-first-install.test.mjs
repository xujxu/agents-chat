import assert from 'node:assert/strict';
import { chmod, chown, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { fixture as runningFixture, ready } from './deployment-linux-service-fixture.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  await chmod(root, 0o755);
  const project = path.join(root, 'fresh app');
  await mkdir(project, { mode: 0o755 });
  await chown(project, 65534, 65534);
  const env = path.join(project, '.env.local');
  await writeFile(env, [
    'NEXTAUTH_SECRET=first-install-private-secret',
    'NEXTAUTH_URL=http://localhost:3010',
    'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=first-install-private-password', '',
  ].join('\n'), { mode: 0o600 });
  await chown(env, 65534, 65534);
  return { root, project, unit: `agents-first-${randomUUID()}.service`,
    control: path.join(root, '.fresh app.deployment'), env };
}

test('fresh installation inspection binds an absent unit, nonroot account and external controller toolchain without mutation', async t => {
  const { inspectLinuxFirstInstall } = await import('../scripts/deployment/linux-first-install.mjs');
  const f = await fixture(t);
  const before = (await readdir(f.root)).sort();
  const original = await readFile(f.env);
  const inspected = await inspectLinuxFirstInstall(f);
  assert.equal(inspected.identity.project, f.project);
  assert.equal(inspected.identity.unit, f.unit);
  assert.equal(inspected.identity.account.uid, 65534);
  assert.equal(inspected.identity.account.gid, 65534);
  assert.equal(inspected.identity.executables[1].file, process.execPath);
  assert.equal(inspected.identity.runtime, 'absent');
  assert.equal(inspected.configuration.buildEnvironment({}).NODE_ENV, 'production');
  assert.equal(JSON.stringify(inspected).includes('first-install-private'), false);
  await inspected.check();
  assert.deepEqual((await readdir(f.root)).sort(), before);
  assert.deepEqual(await readFile(f.env), original);
  await assert.rejects(readdir(f.control), { code: 'ENOENT' });
  await chown(f.project, 0, 0);
  await assert.rejects(inspected.check(), /owner|account|changed/i);
});

for (const existing of ['.data', '.next', 'node_modules', 'control']) {
  test(`fresh installation refuses preexisting ${existing} instead of treating it as an empty deployment`, async t => {
    const { inspectLinuxFirstInstall } = await import('../scripts/deployment/linux-first-install.mjs');
    const f = await fixture(t);
    const directory = existing === 'control' ? f.control : path.join(f.project, existing);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, 'preserve'), 'preexisting evidence');
    await assert.rejects(inspectLinuxFirstInstall(f), /existing|fresh|absent|recovery/i);
    assert.equal(await readFile(path.join(directory, 'preserve'), 'utf8'), 'preexisting evidence');
  });
}

test('fresh installation refuses an existing service even when the proposed project is otherwise empty', async t => {
  const { inspectLinuxFirstInstall } = await import('../scripts/deployment/linux-first-install.mjs');
  const running = await runningFixture(t);
  await ready(running);
  const f = await fixture(t);
  await assert.rejects(inspectLinuxFirstInstall({ ...f, unit: running.unit }), /absent|existing|installed/i);
});

test('fresh installation rechecks configuration and newly created runtime paths', async t => {
  const { inspectLinuxFirstInstall } = await import('../scripts/deployment/linux-first-install.mjs');
  const f = await fixture(t);
  const inspected = await inspectLinuxFirstInstall(f);
  await mkdir(path.join(f.project, '.data'));
  await assert.rejects(inspected.check(), /fresh|absent|existing/i);
  const other = await fixture(t);
  const configuration = await inspectLinuxFirstInstall(other);
  await writeFile(other.env, 'NEXTAUTH_SECRET=changed\n');
  await assert.rejects(configuration.check(), /configuration/i);
});

test('fresh build rechecks preserve absent-unit and identity policy after claiming control and runtime paths', async t => {
  const { inspectLinuxFirstInstall } = await import('../scripts/deployment/linux-first-install.mjs');
  const f = await fixture(t);
  const inspected = await inspectLinuxFirstInstall(f);
  await mkdir(f.control, { mode: 0o700 });
  await writeFile(path.join(f.control, 'state.json'), 'owned build evidence');
  await assert.rejects(inspected.check(), /control|evidence|recovery/i);
  await inspected.checkFreshRuntime();
  await mkdir(path.join(f.project, 'node_modules'));
  await assert.rejects(inspected.checkFreshRuntime(), /existing|fresh/i);
  await inspected.checkUninstalled();
  const running = await runningFixture(t, { unitName: f.unit });
  await ready(running);
  await assert.rejects(inspected.checkUninstalled(), /absent|existing|installed/i);
  await writeFile(f.env, 'NEXTAUTH_SECRET=changed\n');
  await assert.rejects(inspected.checkUninstalled(), /configuration/i);
});
