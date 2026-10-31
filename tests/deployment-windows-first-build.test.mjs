import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { withWindowsFirstBuildFixture as withFixture } from './deployment-windows-first-build-fixture.mjs';
import { registerInertWindowsTask } from './deployment-windows-inert-task.mjs';

const execute = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };

test('Windows first-install build uses original absent-task configuration and lock-bound phase authority', windows, t => withFixture(t, async f => {
  await assert.rejects(f.prepare({ scope: { ...f.scope } }));
  await assert.rejects(f.prepare({ configuration: { ...f.configuration } }));
  await assert.rejects(f.prepare({ git: path.join(f.project, 'fixture-build.cjs') }));
  const stages = await f.prepare();
  const source = await stages.inspect();
  const target = await stages.resolve({ options: { noPull: true } });
  assert.equal(source.commit, f.commit);
  assert.equal(target.commit, f.commit);
  await assert.rejects(stages.select({ target }), /phase|source-selected/i);
  await f.record('source-selected');
  await assert.rejects(stages.select({ target: { ...target, commit: 'f'.repeat(40) } }), /target/i);
  await stages.select({ target });
  await f.record('dependencies');
  await assert.rejects(stages.npm({ stage: 'build', commit: f.commit }), /phase/i);
  await assert.rejects(stages.npm({
    stage: 'dependencies', commit: f.commit, environment: { NEXTAUTH_SECRET: 'changed' },
  }), /configuration/i);
  await stages.npm({ stage: 'dependencies', commit: f.commit });
  await f.record('building');
  const built = await stages.npm({ stage: 'build', commit: f.commit });
  assert.equal(built.sourceCommit, f.commit);
  assert.equal(built.artifacts.identity.buildId, 'first-owned-fixture');
  await built.source.check();
  await built.artifacts.check();
  await f.scope.checkUninstalled();
  await f.configuration.checkFiles();
  for (const name of ['backup', 'deployment.json']) assert.equal(existsSync(path.join(f.control, name)), false);
  await f.record('configuring');
  await assert.rejects(stages.npm({ stage: 'build', commit: f.commit }), /phase/i);
  await f.operation.seal();
  const records = await readWorkerOperation(f.control);
  assert.equal(records.at(-1).phase, 'sealed');
  assert.ok(records.filter(record => record.phase === 'enrolled').length >= 7);
}));

test('Windows first-install build refuses a new competing task before creating artifacts', windows, t => withFixture(t, async f => {
  const stages = await f.prepare();
  const target = await stages.resolve({ options: { noPull: true } });
  await f.record('source-selected');
  await stages.select({ target });
  await f.record('dependencies');
  const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
  let registered = false;
  try {
    await registerInertWindowsTask(f);
    registered = true;
    const query = () => execute(scheduler, ['/Query', '/TN', f.taskName, '/XML'], { timeout: 30000, maxBuffer: 65536 });
    const definition = (await query()).stdout;
    await assert.rejects(stages.npm({ stage: 'dependencies', commit: f.commit }),
      { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    for (const name of ['node_modules', '.next', '.data']) assert.equal(existsSync(path.join(f.project, name)), false);
    assert.equal((await query()).stdout, definition);
    assert.equal(JSON.parse(await readFile(path.join(f.control, 'lock/owner.json'), 'utf8')).token, f.lock.token);
    await f.operation.seal();
  } finally {
    if (registered) await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
  }
}));
