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
