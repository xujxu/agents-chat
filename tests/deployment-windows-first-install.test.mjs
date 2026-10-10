import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';

const execute = promisify(execFile);
const implementation = new URL('../scripts/deployment/windows-first-install.mjs', import.meta.url);
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  assert.ok(existsSync(implementation), 'Missing native Windows first-install inspection');
  const { inspectWindowsFirstInstall } = await import(implementation);
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'fresh-project');
  const control = path.join(root, '.fresh-project.deployment');
  const taskName = `Agents-First-Install-Test-${randomUUID()}`;
  const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  assert.ok(pwsh, 'Actions must supply the original PowerShell executable.');
  await mkdir(project);
  return {
    root, project, control, taskName, pwsh,
    inspect: () => inspectWindowsFirstInstall({ project, taskName, pwsh }),
  };
}

test('Windows first-install inspection retains an absent-task project without creating deployment state', windows, async t => {
  const f = await fixture(t);
  const scope = await f.inspect();
  try {
    assert.equal(scope.observation.status, 'first-install-observed');
    assert.equal(scope.observation.runtimeAuthority, false);
    assert.equal(scope.observation.project, f.project);
    assert.equal(scope.observation.taskName, f.taskName);
    assert.match(scope.observation.accountSid, /^S-1-/);
    assert.ok(Number.isSafeInteger(scope.observation.sessionId));
    await scope.checkFresh();
    assert.deepEqual(await readdir(f.project), []);
    assert.equal(existsSync(f.control), false);
    await assert.rejects(rename(f.project, `${f.project}-replaced`), error =>
      ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    await mkdir(path.join(f.project, '.next'));
    await scope.checkUninstalled();
    await assert.rejects(scope.checkFresh(), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    assert.deepEqual(await readdir(f.project), ['.next']);
  } finally {
    await scope.close();
  }
  await rename(f.project, `${f.project}-closed`);
  await rename(`${f.project}-closed`, f.project);
});

test('Windows first-install inspection refuses old runtime artifacts and control evidence without deleting them', windows, async t => {
  const f = await fixture(t);
  for (const name of ['.data', '.next', 'node_modules']) {
    const artifact = path.join(f.project, name);
    await mkdir(artifact);
    await assert.rejects(f.inspect(), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    assert.deepEqual(await readdir(f.project), [name]);
    await rmdir(artifact);
  }
  await mkdir(f.control, { mode: 0o700 });
  let scope = await f.inspect();
  await scope.close();
  const retained = path.join(f.control, 'retained-evidence');
  await writeFile(retained, 'not a fresh installation');
  await assert.rejects(f.inspect(), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
  assert.equal(await readFile(retained, 'utf8'), 'not a fresh installation');
  assert.deepEqual(await readdir(f.project), []);
});

test('Windows first-install inspection refuses an existing or newly registered task without changing its definition', windows, async t => {
  const f = await fixture(t);
  const scope = await f.inspect();
  const scheduler = path.join(process.env.SystemRoot, 'System32', 'schtasks.exe');
  let registered = false;
  try {
    await mkdir(path.join(f.project, 'scripts'));
    await writeFile(path.join(f.project, 'scripts/service-watchdog.ps1'), 'exit 0\n');
    await execute(f.pwsh, ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('../scripts/install-scheduled-task.ps1', import.meta.url)),
      '-TaskName', f.taskName, '-ProjectDir', f.project], { timeout: 30000, maxBuffer: 16384 });
    registered = true;
    const query = () => execute(scheduler, ['/Query', '/TN', f.taskName, '/XML'], { timeout: 30000, maxBuffer: 65536 });
    const before = (await query()).stdout;
    await assert.rejects(scope.checkFresh(), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    await assert.rejects(f.inspect(), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    assert.equal((await query()).stdout, before);
    assert.equal(existsSync(f.control), false);
  } finally {
    await scope.close();
    if (registered) await execute(scheduler, ['/Delete', '/TN', f.taskName, '/F'], { timeout: 30000, maxBuffer: 16384 });
  }
});
