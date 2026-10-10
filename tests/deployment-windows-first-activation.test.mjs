import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareWindowsFirstRuntime } from '../scripts/deployment/windows-first-runtime.mjs';
import { withWindowsFirstBuildFixture, buildWindowsFirstFixture } from './deployment-windows-first-build-fixture.mjs';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };
const waitForNoInstances = async f => execute(f.pwsh, ['-NoProfile', '-NonInteractive', '-Command',
  `$s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\'); `
  + `$limit=[Diagnostics.Stopwatch]::StartNew(); while($f.GetTask('${f.taskName}').GetInstances(0).Count) { `
  + `if($limit.ElapsedMilliseconds -gt 30000) { throw 'Original task instance did not settle.' }; Start-Sleep -Milliseconds 100 }`,
], { timeout: 40000, maxBuffer: 16384 });

for (const running of [true, false]) {
  test(`Windows first-install guarded activation ${running ? 'starts only the original runtime and settles on close' : 'refuses an exited application without accepting a deployment'}`,
    windows, async t => {
      await withWindowsFirstBuildFixture(t, async f => {
        const built = await buildWindowsFirstFixture(f);
        await f.record('configuring');
        await f.operation.seal();
        const published = await prepareWindowsFirstRuntime({ ...f, built, port: 3010 });
        const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
        let registered = false;
        try {
          assert.equal(typeof published.activate, 'function', 'Missing guarded first Windows runtime activation');
          await assert.rejects(published.activate());
          const task = await published.registerTask({ logonType: 'S4U', triggerType: 'AtStartup' });
          registered = true;
          await assert.rejects(published.activate());
          await published.prepareActivation();
          await assert.rejects(published.activate());
          await f.record('activating');
          if (running) {
            const active = await published.activate();
            assert.equal(active.status, 'first-runtime-running');
            assert.equal(active.applicationHealthy, false);
            assert.equal(active.taskName, f.taskName);
            assert.equal(active.configurationSha256, task.configurationSha256);
            assert.equal(active.controllerPid, task.controllerPid);
            assert.equal(active.controllerIdentity, task.controllerIdentity);
            assert.match(active.runtime.generation, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
            assert.match(active.runtime.identity, new RegExp(`^${active.runtime.pid}:\\d+$`));
            assert.ok(active.runtime.launcherPid > 0);
            assert.notEqual(active.runtime.pid, task.controllerPid);
            await published.checkFiles();
            await assert.rejects(published.activate());
            const saved = JSON.parse(await readFile(path.join(f.control,
              `first-task-${f.lock.operationId}`, 'activation-running.json'), 'utf8'));
            assert.deepEqual(saved, active);
          } else {
            await assert.rejects(published.activate());
          }
          assert.equal(existsSync(path.join(f.control, 'deployment.json')), false);
          assert.equal(existsSync(path.join(f.control, 'backup')), false);
          assert.equal(existsSync(path.join(f.project, '.data')), false);
        } finally {
          await published.close();
          if (registered) {
            await waitForNoInstances(f);
            await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
          }
        }
      }, { runtimeScript: running ? 'setInterval(() => {}, 1000);' : 'process.exit(1);' });
    });
}
