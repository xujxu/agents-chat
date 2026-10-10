import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { withWindowsFirstBuildFixture, buildWindowsFirstFixture } from './deployment-windows-first-build-fixture.mjs';
import { registerInertWindowsTask } from './deployment-windows-inert-task.mjs';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };
const implementation = new URL('../scripts/deployment/windows-first-runtime.mjs', import.meta.url);
async function publication() {
  assert.ok(existsSync(implementation), 'Missing native Windows first-runtime publication');
  return (await import(implementation)).prepareWindowsFirstRuntime;
}

test('Windows first-install runtime publication requires sealed configuring authority and retains a private prebuilt bundle', windows, async t => {
  const prepare = await publication();
  await withWindowsFirstBuildFixture(t, async f => {
    const built = await buildWindowsFirstFixture(f);
    const directory = path.join(f.control, `first-runtime-${f.lock.operationId}`);
    const options = { ...f, built, port: 3010 };
    await assert.rejects(prepare(options));
    assert.equal(existsSync(directory), false);
    await f.record('configuring');
    await assert.rejects(prepare(options));
    assert.equal(existsSync(directory), false);
    await f.operation.seal();
    for (const override of [
      { scope: { ...f.scope } }, { configuration: { ...f.configuration } }, { port: 0 },
      { environment: { ...f.environment, PATH: 'x'.repeat(131072) } },
    ]) {
      await assert.rejects(prepare({ ...options, ...override }));
      assert.equal(existsSync(directory), false);
    }
    const published = await prepare(options);
    let original;
    try {
      assert.equal(published.status, 'runtime-prepared');
      assert.equal(published.runtimeAuthority, false);
      assert.equal(published.bundle.directory, directory);
      assert.equal(published.bundle.configuration, path.join(directory, 'configuration.json'));
      assert.match(published.bundle.sha256, /^[a-f0-9]{64}$/);
      original = await readFile(published.bundle.configuration);
      const configuration = JSON.parse(original);
      assert.equal(configuration.command.file, f.node);
      assert.equal(configuration.command.cwd, f.project);
      assert.deepEqual(configuration.command.args, [
        path.join(f.project, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3010',
      ]);
      assert.equal(configuration.command.environment.NODE_ENV, 'production');
      assert.equal(configuration.command.environment.NEXTAUTH_SECRET, undefined);
      assert.equal(configuration.command.environment.ADMIN_PASSWORD, undefined);
      assert.equal(configuration.command.environment.NODE_OPTIONS, undefined);
      await published.checkFiles();
      await assert.rejects(rename(directory, `${directory}-moved`));
      await f.scope.checkUninstalled();
      assert.equal(existsSync(path.join(f.control, 'deployment.json')), false);
      assert.equal(existsSync(path.join(f.project, '.data')), false);
    } finally { await published.close(); }
    await assert.rejects(prepare(options));
    assert.deepEqual(await readFile(path.join(directory, 'configuration.json')), original);
    await rename(directory, `${directory}-closed`);
    await rename(`${directory}-closed`, directory);
  });
});

test('Windows first-install runtime publication refuses a competing task without creating a bundle', windows, async t => {
  const prepare = await publication();
  await withWindowsFirstBuildFixture(t, async f => {
    const built = await buildWindowsFirstFixture(f);
    await f.record('configuring');
    await f.operation.seal();
    const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
    let registered = false;
    try {
      await registerInertWindowsTask(f);
      registered = true;
      const query = () => execute(scheduler, ['/Query', '/TN', f.taskName, '/XML'], { timeout: 30000, maxBuffer: 65536 });
      const definition = (await query()).stdout;
      await assert.rejects(prepare({ ...f, built, port: 3010 }));
      assert.equal(existsSync(path.join(f.control, `first-runtime-${f.lock.operationId}`)), false);
      assert.equal((await query()).stdout, definition);
    } finally {
      if (registered) await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
    }
  });
});

test('Windows first-install task registration binds an inhibited task to the original retained publisher', windows, async t => {
  const prepare = await publication();
  await withWindowsFirstBuildFixture(t, async f => {
    const built = await buildWindowsFirstFixture(f);
    await f.record('configuring');
    await f.operation.seal();
    const published = await prepare({ ...f, built, port: 3010 });
    const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
    const directory = path.join(f.control, `first-task-${f.lock.operationId}`);
    let registered = false;
    try {
      assert.equal(typeof published.registerTask, 'function', 'Missing original-publisher first-task registration');
      for (const options of [{ logonType: 'Password' }, { triggerType: 'Daily' }]) {
        await assert.rejects(published.registerTask(options));
        assert.equal(existsSync(directory), false);
      }
      const task = await published.registerTask();
      registered = true;
      assert.equal(task.status, 'first-task-prepared');
      assert.equal(task.runtimeAuthority, false);
      assert.equal(task.taskName, f.taskName);
      assert.equal(task.accountSid, f.scope.observation.accountSid);
      assert.equal(task.logonType, 'Interactive');
      assert.equal(task.triggerType, 'AtLogOn');
      assert.equal(task.configuration, published.bundle.configuration);
      assert.equal(task.configurationSha256, published.bundle.sha256);
      assert.match(task.definition, /<Enabled>false<\/Enabled>/);
      assert.doesNotMatch(task.definition, /<LogonTrigger|<BootTrigger|<RestartOnFailure/);
      assert.match(task.definition, /-ControllerPid \d+ -ControllerIdentity \d+:\d+/);
      assert.match(task.permanentDefinition, /<LogonTrigger/);
      assert.doesNotMatch(task.permanentDefinition, /-ControllerPid/);
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'registered.json'), 'utf8')), task);
      await published.checkFiles();
      await assert.rejects(published.registerTask());
      await published.checkFiles();
      assert.equal(existsSync(path.join(f.control, 'deployment.json')), false);
      assert.equal(existsSync(path.join(f.control, 'backup')), false);
      assert.equal(existsSync(path.join(f.project, '.data')), false);
      const state = JSON.parse(await readFile(path.join(f.control, 'state.json'), 'utf8'));
      assert.equal(state.phase, 'configuring');
    } finally {
      await published.close();
      if (registered) await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
    }
    await assert.rejects(published.registerTask());
    await rename(directory, `${directory}-closed`);
    await rename(`${directory}-closed`, directory);
  });
});

test('Windows first-install task registration preserves a competitor registered after runtime publication', windows, async t => {
  const prepare = await publication();
  await withWindowsFirstBuildFixture(t, async f => {
    const built = await buildWindowsFirstFixture(f);
    await f.record('configuring');
    await f.operation.seal();
    const published = await prepare({ ...f, built, port: 3010 });
    const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
    let registered = false;
    try {
      assert.equal(typeof published.registerTask, 'function', 'Missing original-publisher first-task registration');
      await registerInertWindowsTask(f);
      registered = true;
      const query = () => execute(scheduler, ['/Query', '/TN', f.taskName, '/XML'], { timeout: 30000, maxBuffer: 65536 });
      const before = (await query()).stdout;
      await assert.rejects(published.registerTask({ logonType: 'S4U', triggerType: 'AtStartup' }));
      assert.equal(existsSync(path.join(f.control, `first-task-${f.lock.operationId}`)), false);
      assert.equal((await query()).stdout, before);
    } finally {
      await published.close();
      if (registered) await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
    }
  });
});
