import assert from 'node:assert/strict';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectConfigurationFiles } from '../scripts/deployment/configuration-files.mjs';

const profile = 'agents-chat-auth-638c553';
const environment = {
  NODE_ENV: 'production', NEXTAUTH_SECRET: 'fixture-private-secret',
  NEXTAUTH_URL: 'http://localhost:3010', ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'fixture-private-password',
};
const inspect = (project, extra = {}) => inspectConfigurationFiles({ project, profile, environment, ...extra });

test('explicit runtime environment is inspected without consulting controller secrets', async t => {
  const project = await temporaryDeployment(t);
  const result = await inspect(project);
  assert.equal(result.status, 'configuration-supported');
  assert.deepEqual(result.providers, ['admin-login']);
  assert.equal(result.files.length, 4);
  assert.ok(result.files.every(file => !file.present));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  await result.check();
});

test('build environment uses installed configuration without exposing it in reports', async t => {
  const project = await temporaryDeployment(t);
  await writeFile(path.join(project, '.env.production.local'),
    'NEXT_PUBLIC_DEPLOYMENT_VALUE=installed\nADMIN_PASSWORD=lower-priority\n');
  const result = await inspect(project);
  const supplied = { PATH: '/installed/bin', HOME: '/installed/home', NEXT_TELEMETRY_DISABLED: '1' };
  const build = result.buildEnvironment(supplied);
  assert.equal(build.ADMIN_PASSWORD, environment.ADMIN_PASSWORD);
  assert.equal(build.NEXT_PUBLIC_DEPLOYMENT_VALUE, 'installed');
  assert.equal(build.PATH, supplied.PATH);
  assert.equal(build.NEXT_TELEMETRY_DISABLED, '1');
  assert.equal(Object.isFrozen(build), true);
  supplied.PATH = '/changed';
  assert.equal(build.PATH, '/installed/bin');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|lower-priority|installed/);
});

test('startup environment excludes Next dotenv values but retains ordered systemd assignments', async t => {
  const project = await temporaryDeployment(t);
  const machine = path.join(project, 'runtime.env');
  await writeFile(machine, 'NEXTAUTH_URL=https://runtime.example\n');
  await writeFile(path.join(project, '.env.production.local'),
    'PATH=/dotenv-only/bin\nNEXT_PUBLIC_DEPLOYMENT_VALUE=dotenv-only\n');
  const result = await inspect(project, { systemdFiles: [{ path: machine, optional: false }] });
  const startup = result.startupEnvironment();
  assert.deepEqual(startup, { ...environment, NEXTAUTH_URL: 'https://runtime.example' });
  assert.equal(Object.isFrozen(startup), true);
  assert.equal(result.buildEnvironment({}).PATH, '/dotenv-only/bin');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|runtime\.example|dotenv-only/);
  await result.check();
});

test('build environment refuses conflicting or unconfigured controller settings without secrets', async t => {
  const project = await temporaryDeployment(t);
  const result = await inspect(project);
  for (const supplied of [
    { NEXTAUTH_SECRET: 'controller-private-secret' },
    { NEXT_PUBLIC_DEPLOYMENT_VALUE: 'controller-private-setting' },
    { NODE_OPTIONS: '--require=private-hook' },
    { __NEXT_PROCESSED_ENV: 'true' },
  ]) {
    assert.throws(() => result.buildEnvironment(supplied), error => {
      assert.equal(error.code, 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED');
      assert.equal(error.check, 'build-environment-conflict');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-|controller-/);
      return true;
    });
  }
  assert.equal(result.buildEnvironment({ ...environment }).NEXTAUTH_URL, environment.NEXTAUTH_URL);
});

test('unsupported installed Node injection is refused before preparing a build', async t => {
  const project = await temporaryDeployment(t);
  const result = await inspect(project, { environment: { ...environment, NODE_OPTIONS: '--require=private-hook' } });
  assert.throws(() => result.buildEnvironment({}), { check: 'build-environment-policy' });
});

test('build environment defaults an absent Node mode but refuses explicit empty or development mode', async t => {
  const project = await temporaryDeployment(t);
  const runtime = { ...environment };
  delete runtime.NODE_ENV;
  assert.equal((await inspect(project, { environment: runtime })).buildEnvironment({}).NODE_ENV, 'production');
  await writeFile(path.join(project, '.env'), 'NODE_ENV=\n');
  const result = await inspect(project, { environment: runtime });
  assert.throws(() => result.buildEnvironment({}), { check: 'build-environment-policy' });
  await writeFile(path.join(project, '.env'), 'NODE_ENV=development\n');
  await assert.rejects(inspect(project, { environment: runtime }), { check: 'NODE_ENV' });
});

test('systemd ordered files override environment and Next files only fill missing keys', async t => {
  const project = await temporaryDeployment(t);
  const first = path.join(project, '.env.local');
  const machine = path.join(project, 'machine.env');
  await writeFile(first, 'NEXTAUTH_URL=https://project.example\nADMIN_USERNAME=\n');
  await writeFile(machine, "NEXTAUTH_URL='https://machine.example'\nADMIN_USERNAME=fixture\n");
  await writeFile(path.join(project, '.env.production.local'), 'NEXTAUTH_URL=invalid\nADMIN_PASSWORD=\n');
  const before = await readFile(first);
  const result = await inspect(project, { systemdFiles: [
    { path: first, optional: true }, { path: machine, optional: false },
  ] });
  assert.equal(result.buildEnvironment({}).NEXTAUTH_URL, 'https://machine.example');
  await result.check();
  assert.deepEqual(await readFile(first), before);
  await writeFile(machine, 'NEXTAUTH_URL=invalid\n');
  await assert.rejects(result.check(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
});

test('production dotenv priority is deterministic, including an explicit empty string', async t => {
  const project = await temporaryDeployment(t);
  await writeFile(path.join(project, '.env.production.local'), 'NEXTAUTH_SECRET=valid\n');
  await writeFile(path.join(project, '.env.local'), 'NEXTAUTH_SECRET=\n');
  await writeFile(path.join(project, '.env.production'), 'NEXTAUTH_SECRET=lower\n');
  const runtime = { ...environment };
  delete runtime.NEXTAUTH_SECRET;
  const result = await inspect(project, { environment: runtime });
  assert.equal(result.buildEnvironment({}).NEXTAUTH_SECRET, 'valid');
  await assert.rejects(inspect(project, { environment: { ...runtime, NEXTAUTH_SECRET: '' } }),
    { check: 'NEXTAUTH_SECRET' });
});

test('read-only configuration recheck retains absence and file identity, not just equivalent settings', async t => {
  for (const change of ['add', 'replace']) {
    const project = await temporaryDeployment(t);
    const file = path.join(project, '.env');
    if (change === 'replace') await writeFile(file, '# original\n');
    const result = await inspect(project);
    if (change === 'replace') await rename(file, `${file}.old`);
    await writeFile(file, '# original\n');
    await assert.rejects(result.check(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  }
});

for (const content of [
  'NEXTAUTH_SECRET=$OTHER', 'NEXTAUTH_SECRET="${OTHER}"', 'NEXTAUTH_SECRET="line\\nvalue"',
  'export NEXTAUTH_SECRET=value', 'NEXTAUTH_SECRET="first\nsecond"', 'NEXTAUTH_SECRET=x\0y',
  'private-unrecognized-line',
  'NEXTAUTH_SECRET=`private-backtick-quoted`',
]) {
  test(`unsupported dotenv syntax is refused without exposing content ${JSON.stringify(content).length}`, async t => {
    const project = await temporaryDeployment(t);
    await writeFile(path.join(project, '.env'), content);
    await assert.rejects(inspect(project), error => {
      assert.equal(error.code, 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-|OTHER|first|second/);
      return true;
    });
  });
}

test('configuration file budget is checked before reading bytes', async t => {
  const project = await temporaryDeployment(t);
  await writeFile(path.join(project, '.env'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(inspect(project), { check: 'configuration-file' });
});

test('required missing files and directory substitutions refuse rather than becoming empty settings', async t => {
  const project = await temporaryDeployment(t);
  await assert.rejects(inspect(project, { systemdFiles: [
    { path: path.join(project, 'missing'), optional: false },
  ] }), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  await mkdir(path.join(project, '.env'));
  await assert.rejects(inspect(project), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
});

test('linked configuration sources are unsupported', { skip: process.platform === 'win32' }, async t => {
  const project = await temporaryDeployment(t);
  await writeFile(path.join(project, 'actual'), 'NEXTAUTH_SECRET=secret');
  await symlink('actual', path.join(project, '.env'));
  await assert.rejects(inspect(project), { check: 'configuration-file' });
});

test('startup environment must match configured values before Next dotenv loading', async t => {
  const project = await temporaryDeployment(t);
  const file = path.join(project, 'service.env');
  await writeFile(file, 'ADMIN_PASSWORD=changed-private-password\n');
  await assert.rejects(inspect(project, {
    systemdFiles: [{ path: file, optional: false }], observedEnvironment: environment,
  }), { check: 'runtime-environment-changed' });
});

test('a removed startup setting is not inherited from the running process', async t => {
  const project = await temporaryDeployment(t);
  const configured = { ...environment };
  delete configured.ADMIN_USERNAME;
  delete configured.ADMIN_PASSWORD;
  await assert.rejects(inspect(project, { environment: configured, observedEnvironment: environment }),
    { check: 'runtime-environment-changed' });
});

test('dotenv-only settings are compared after the startup environment observation', async t => {
  const project = await temporaryDeployment(t);
  await writeFile(path.join(project, '.env.production.local'), 'ADMIN_USERNAME=fixture\nADMIN_PASSWORD=private-password\n');
  const configured = { ...environment };
  delete configured.ADMIN_USERNAME;
  delete configured.ADMIN_PASSWORD;
  const result = await inspect(project, { environment: configured, observedEnvironment: configured });
  assert.deepEqual(result.providers, ['admin-login']);
});

test('Next environment-load suppression is refused rather than predicting files will load', async t => {
  const project = await temporaryDeployment(t);
  await assert.rejects(inspect(project, { environment: { ...environment, __NEXT_PROCESSED_ENV: 'true' } }),
    { check: 'runtime-environment-policy' });
});

test('configuration source recheck uses the new stage signal while keeping captured evidence', async t => {
  const project = await temporaryDeployment(t);
  const old = new AbortController();
  const result = await inspect(project, { signal: old.signal });
  old.abort(new Error('previous stage ended'));
  await result.check({ signal: new AbortController().signal });
  await writeFile(path.join(project, '.env'), '# changed');
  await assert.rejects(result.check({ signal: new AbortController().signal }),
    { check: 'configuration-changed' });
});
