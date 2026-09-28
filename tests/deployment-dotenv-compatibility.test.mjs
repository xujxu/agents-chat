import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectConfigurationFiles } from '../scripts/deployment/configuration-files.mjs';
import { authenticationEnvironmentNames, inspectConfigurationCompatibility } from '../scripts/deployment/configuration-compatibility.mjs';

const execute = promisify(execFile);
const loader = createRequire(import.meta.url).resolve('@next/env');
const profile = 'agents-chat-auth-638c553';
const base = { NODE_ENV: 'production', NEXTAUTH_URL: 'http://localhost:3010', NEXTAUTH_SECRET: 'private-fixture-secret' };
const credentials = 'ADMIN_USERNAME=fixture\nADMIN_PASSWORD=private-fixture-password\n';

for (const [name, files, expected] of [
  ['production-priority', {
    '.env.production.local': credentials,
    '.env.local': 'ADMIN_PASSWORD=\n',
    '.env.production': 'ADMIN_USERNAME=\n',
    '.env': 'NEXTAUTH_SECRET=\n',
  }, { ...base, ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password' }],
  ['quoted-literals', {
    '.env': '# comment\r\nADMIN_USERNAME = "fixture user"\r\nADMIN_PASSWORD=\'private#fixture password\'\r\n',
  }, { ...base, ADMIN_USERNAME: 'fixture user', ADMIN_PASSWORD: 'private#fixture password' }],
  ['duplicate-assignment', {
    '.env': 'ADMIN_USERNAME=old\nADMIN_USERNAME=fixture\nADMIN_PASSWORD=private-fixture-password\n',
  }, { ...base, ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password' }],
  ['empty-value-preserved', {
    '.env.production.local': credentials + 'GITHUB_CLIENT_ID=\n',
    '.env': 'GITHUB_CLIENT_ID=ignored\nGITHUB_CLIENT_SECRET=\n',
  }, { ...base, ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password',
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }],
  ['utf8-bom', {
    '.env': `\ufeff${credentials}`,
  }, { ...base, ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'private-fixture-password' }],
]) {
  test(`supported assignments match the installed Next production loader: ${name}`, async t => {
    const project = await temporaryDeployment(t);
    for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(project, file), bytes);
    const { stdout } = await execute(process.execPath, ['-e', `
      const { loadEnvConfig } = require(${JSON.stringify(loader)});
      const result = loadEnvConfig(process.argv[1], false, { info() {}, error() { throw Error('dotenv fixture failed'); } }, true);
      const names = ${JSON.stringify(authenticationEnvironmentNames)};
      process.stdout.write(JSON.stringify(Object.fromEntries(names.filter(name =>
        Object.hasOwn(result.combinedEnv, name)).map(name => [name, result.combinedEnv[name]]))));
    `, project], { env: base, timeout: 30000, maxBuffer: 8192 });
    const actual = JSON.parse(stdout);
    assert.deepEqual(actual, expected);
    const admitted = await inspectConfigurationFiles({ project, profile, environment: base });
    const native = inspectConfigurationCompatibility({ profile, environment: actual });
    assert.equal(admitted.status, native.status);
    assert.deepEqual(admitted.providers, native.providers);
    await admitted.check();
  });
}
