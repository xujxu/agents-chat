import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment, acquireLock } from './deployment-fixture.mjs';
import { inspectWindowsFirstInstall } from '../scripts/deployment/windows-first-install.mjs';
import { inspectWindowsFirstConfiguration } from '../scripts/deployment/windows-configuration.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { writeState } from '../scripts/deployment/state.mjs';

const execute = promisify(execFile);
const implementation = new URL('../scripts/deployment/windows-first-build.mjs', import.meta.url);
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  assert.ok(existsSync(implementation), 'Missing owned Windows first-install build');
  const { prepareWindowsFirstBuild } = await import(implementation);
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'fresh-source');
  const control = path.join(root, '.fresh-source.deployment');
  const taskName = `Agents-First-Build-Test-${randomUUID()}`;
  const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  const git = process.env.DEPLOYMENT_TEST_GIT;
  const npmCli = process.env.DEPLOYMENT_TEST_NPM_CLI;
  assert.ok(pwsh && git && npmCli, 'Actions must supply the original native toolchain.');
  await mkdir(project);
  const setup = async (...args) => (await execute(git, ['-C', project, ...args], {
    timeout: 30000, maxBuffer: 16384,
  })).stdout.trim();
  await setup('init', '--initial-branch=main');
  await setup('config', 'user.name', 'Deployment fixture');
  await setup('config', 'user.email', 'fixture@example.invalid');
  await setup('config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, '.gitignore'), '*\n!.gitignore\n!package.json\n!package-lock.json\n!fixture-build.cjs\n');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'first-build-fixture', version: '1.0.0', private: true, scripts: { build: 'node fixture-build.cjs' },
  }));
  await writeFile(path.join(project, 'package-lock.json'), JSON.stringify({
    name: 'first-build-fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'first-build-fixture', version: '1.0.0' } },
  }));
  await writeFile(path.join(project, 'fixture-build.cjs'), `
const fs = require('node:fs');
fs.mkdirSync('node_modules', { recursive: true });
fs.mkdirSync('.next', { recursive: true });
fs.writeFileSync('.next/BUILD_ID', 'first-owned-fixture');
`);
  await setup('add', '.');
  await setup('commit', '-m', 'fresh fixture');
  const commit = await setup('rev-parse', 'HEAD');
  await writeFile(path.join(project, '.env'), 'NEXTAUTH_SECRET=fixture-first-build\nNEXTAUTH_URL=http://localhost:3010\n'
    + 'ADMIN_USERNAME=fixture\nADMIN_PASSWORD=fixture-first-build-password\n');
  const scope = await inspectWindowsFirstInstall({ project, taskName, pwsh });
  let configuration;
  let operation;
  const close = async () => {
    const results = await Promise.allSettled([operation?.close(), configuration?.close(), scope.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Fresh build fixture close failed.');
  };
  try {
    configuration = await inspectWindowsFirstConfiguration({ scope, pwsh, profile: 'agents-chat-auth-638c553' });
    await mkdir(control, { mode: 0o700 });
    const lock = await acquireLock(control, { project, operationId: randomUUID() });
    let state = {
      version: 1, operationId: lock.operationId, project, operation: 'deploy', phase: 'preflight',
      previousPhase: null, sourceCommit: null, targetCommit: null, backupId: null, priorRuntime: 'absent',
      runtimeIdentity: 'first-install-absent', startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
    };
    await writeState(control, state);
    const saved = await saveWorkerEngine({
      source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), control, project, operationId: lock.operationId,
    });
    operation = await createWorkerOperation({ control, lock, saved });
    const environment = Object.fromEntries(['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
      .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    environment.NPM_CONFIG_CACHE = path.join(root, 'npm-cache');
    environment.NEXT_TELEMETRY_DISABLED = '1';
    const options = { scope, configuration, control, lock, operation, node: process.execPath, npmCli, git, pwsh, environment };
    const record = async phase => {
      state = { ...state, previousPhase: state.phase, phase, sourceCommit: commit, targetCommit: commit };
      await writeState(control, state);
    };
    return {
      ...options, project, taskName, commit, record, close,
      prepare: overrides => prepareWindowsFirstBuild({ ...options, ...overrides }),
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Fresh build fixture setup and close failed.'); }
    throw error;
  }
}

async function withFixture(t, run) {
  const f = await fixture(t);
  try { await run(f); }
  finally { await f.close(); }
}

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
    await execute(f.pwsh, ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('../scripts/install-scheduled-task.ps1', import.meta.url)),
      '-TaskName', f.taskName, '-ProjectDir', f.project], { timeout: 30000, maxBuffer: 16384 });
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
