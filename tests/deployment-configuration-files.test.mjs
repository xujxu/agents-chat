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
  assert.deepEqual(result.providers, ['credentials']);
  assert.equal(result.files.length, 4);
  assert.ok(result.files.every(file => !file.present));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  await result.check();
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
  await inspect(project, { environment: runtime });
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
