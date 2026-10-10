import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { registerInertWindowsTask } from './deployment-windows-inert-task.mjs';

const execute = promisify(execFile);
const implementation = new URL('../scripts/deployment/windows-first-install.mjs', import.meta.url);
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  assert.ok(existsSync(implementation), 'Missing native Windows first-install inspection');
  const { inspectWindowsFirstInstall, assertWindowsFirstInstallScope } = await import(implementation);
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
    checkOriginal: scope => assertWindowsFirstInstallScope(scope),
    configure: async scope => {
      const { inspectWindowsFirstConfiguration } = await import('../scripts/deployment/windows-configuration.mjs');
      assert.equal(typeof inspectWindowsFirstConfiguration, 'function', 'Missing native Windows first-install configuration');
      return inspectWindowsFirstConfiguration({ scope, pwsh, profile: 'agents-chat-auth-638c553' });
    },
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
    await f.checkOriginal(scope);
    await assert.rejects(f.checkOriginal({ ...scope }), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
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
  await assert.rejects(f.checkOriginal(scope), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
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
    await registerInertWindowsTask(f);
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

const configurationText = 'nextauth_secret=fixture-first-config-secret\nnextauth_url=http://localhost:3010\n'
  + 'admin_username=fixture\nadmin_password=fixture-first-config-password\n';

test('Windows first-install configuration retains actual dotenv sources without inventing installed configuration', windows, async t => {
  const f = await fixture(t);
  const file = path.join(f.project, '.env.production.local');
  const agents = path.join(f.project, 'agents.json');
  await writeFile(file, configurationText);
  await writeFile(path.join(f.project, '.env'), 'NEXTAUTH_SECRET=lower-priority-fixture\n');
  await writeFile(agents, '{"agents":[]}');
  const scope = await f.inspect();
  let configuration;
  try {
    configuration = await f.configure(scope);
    await assert.rejects(f.configure({ ...scope }), { code: 'DEPLOYMENT_WINDOWS_FIRST_INSTALL_REFUSED' });
    assert.equal(configuration.status, 'configuration-supported');
    assert.deepEqual(configuration.providers, ['admin-login']);
    assert.equal(configuration.buildEnvironment({}).NEXTAUTH_SECRET, 'fixture-first-config-secret');
    assert.equal(configuration.buildEnvironment({}).ADMIN_PASSWORD, 'fixture-first-config-password');
    assert.deepEqual(configuration.startupEnvironment(), { NODE_ENV: 'production' });
    assert.doesNotMatch(JSON.stringify(configuration), /fixture-first-config/);
    assert.equal(configuration.files.length, 5);
    assert.equal(configuration.files.find(source => source.path === agents).present, true);
    assert.ok(configuration.files.find(source => source.path === file).securityDescriptor);
    await configuration.checkFiles();
    await assert.rejects(rename(file, `${file}-moved`));
    await assert.rejects(writeFile(agents, '{"changed":true}'));
    assert.equal(await readFile(file, 'utf8'), configurationText);
    assert.equal(await readFile(agents, 'utf8'), '{"agents":[]}');
    assert.equal(existsSync(f.control), false);
    await mkdir(path.join(f.project, '.next'));
    await configuration.checkFiles();
  } finally {
    try { await configuration?.close(); }
    finally { await scope.close(); }
  }
  await rename(file, `${file}-closed`);
  await rename(`${file}-closed`, file);
});

test('Windows first-install configuration refuses newly appearing higher-priority sources without removing them', windows, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.project, '.env'), configurationText);
  const scope = await f.inspect();
  let configuration;
  const added = path.join(f.project, '.env.local');
  try {
    configuration = await f.configure(scope);
    await writeFile(added, 'NEXTAUTH_SECRET=changed-fixture\n');
    await assert.rejects(configuration.checkFiles(), { code: 'DEPLOYMENT_WINDOWS_CONFIGURATION_REFUSED' });
    assert.equal(await readFile(added, 'utf8'), 'NEXTAUTH_SECRET=changed-fixture\n');
    assert.equal(existsSync(f.control), false);
  } finally {
    try { await configuration?.close(); }
    finally { await scope.close(); }
  }
});

test('Windows first-install configuration refuses unsupported authentication and injected Node hooks before mutation', windows, async t => {
  const f = await fixture(t);
  const scope = await f.inspect();
  const file = path.join(f.project, '.env');
  try {
    for (const text of [
      'NEXTAUTH_SECRET=change-me-to-a-random-string\n',
      'NEXTAUTH_SECRET=fixture\nNEXTAUTH_URL=http://localhost:3010\n',
      `${configurationText}NODE_OPTIONS=--inspect\n`,
      `${configurationText}NODE_PATH=unexpected-fixture\n`,
    ]) {
      await writeFile(file, text);
      await assert.rejects(f.configure(scope), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
      assert.equal(await readFile(file, 'utf8'), text);
      assert.equal(existsSync(f.control), false);
    }
    await scope.checkFresh();
  } finally { await scope.close(); }
});
