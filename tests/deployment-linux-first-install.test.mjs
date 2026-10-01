import assert from 'node:assert/strict';
import { chown, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { freshInstallationFixture as fixture } from './deployment-linux-first-fixture.mjs';
import { fixture as runningFixture, ready } from './deployment-linux-service-fixture.mjs';

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
