import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';
import { inspectConfigurationCompatibility } from '../scripts/deployment/configuration-compatibility.mjs';
import { runDeployment } from '../scripts/deployment/transaction.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const baseline = '638c553c62406dbb7e6b5aeb41cdddf4cd6de179';
const git = async (project, args) => (await execute('git', ['-C', project, ...args])).stdout.trim();
const metadata = {
  version: 1, databaseProfile: 'agents-chat-638c553', configurationProfile: 'agents-chat-auth-638c553',
  runtimeProfile: 'agents-chat-node24-638c553',
};
const environment = {
  NEXTAUTH_SECRET: 'fixture-secret-not-to-be-serialized', NEXTAUTH_URL: 'http://localhost:3010',
  ADMIN_USERNAME: 'fixture-user', ADMIN_PASSWORD: 'fixture-password-not-to-be-serialized',
};
async function targetFixture(t, change) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'repo');
  await execute('git', ['clone', '--quiet', '--no-hardlinks', '--shared', repository, project]);
  await git(project, ['config', 'user.name', 'Fixture']);
  await git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await git(project, ['config', 'core.autocrlf', 'false']);
  await git(project, ['switch', '--detach', baseline]);
  await mkdir(path.join(project, 'scripts', 'deployment'), { recursive: true });
  await writeFile(path.join(project, 'scripts', 'deployment', 'protocol.json'), '{"version":1,"snapshotVersion":1}');
  await writeFile(path.join(project, 'scripts', 'deployment', 'compatibility.json'), JSON.stringify(metadata));
  await change?.(project);
  await git(project, ['add', '.']);
  await git(project, ['commit', '-m', 'target']);
  const commit = await git(project, ['rev-parse', 'HEAD']);
  await git(project, ['switch', '--detach', baseline]);
  return { project, commit };
}
const inspect = f => inspectTargetCompatibility({ ...f, nodeVersion: '24.0.0', platform: process.platform });

test('pinned historical target is identified without inventing transaction protocol support', async () => {
  const result = await inspect({ project: repository, commit: baseline });
  assert.equal(result.status, 'target-supported');
  assert.equal(result.protocol, null);
  assert.equal(result.mode, 'historical');
  assert.equal(result.databaseProfile, metadata.databaseProfile);
  assert.ok(result.pendingChecks.includes('historical-adapter'));
  assert.ok(result.pendingChecks.includes('persisted-content'));
});

test('declared target reads immutable Git objects, not a dirty working checkout', async t => {
  const f = await targetFixture(t);
  const index = await readFile(path.join(f.project, '.git', 'index'));
  await writeFile(path.join(f.project, 'package.json'), '{"engines":{"node":"secret-unsupported"}}');
  const before = await git(f.project, ['rev-parse', 'HEAD']);
  const result = await inspect(f);
  assert.equal(result.mode, 'declared');
  assert.deepEqual(result.protocol, { version: 1, snapshotVersion: 1 });
  assert.equal(result.commit, f.commit);
  assert.deepEqual(await readFile(path.join(f.project, '.git', 'index')), index);
  assert.equal(await git(f.project, ['rev-parse', 'HEAD']), before);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

for (const [name, change] of [
  ['protocol', async p => writeFile(path.join(p, 'scripts/deployment/protocol.json'), '{"version":9,"snapshotVersion":1}')],
  ['extra-field', async p => writeFile(path.join(p, 'scripts/deployment/compatibility.json'), JSON.stringify({ ...metadata, skipChecks: true }))],
  ['profile', async p => writeFile(path.join(p, 'scripts/deployment/compatibility.json'), JSON.stringify({ ...metadata, databaseProfile: 'future' }))],
  ['malformed', async p => writeFile(path.join(p, 'scripts/deployment/compatibility.json'), '{"secret-invalid":')],
  ['oversized', async p => writeFile(path.join(p, 'scripts/deployment/compatibility.json'), ' '.repeat(17000))],
  ['package', async p => writeFile(path.join(p, 'package.json'), '{"engines":{"node":">=99"}}')],
  ['lockfile', async p => writeFile(path.join(p, 'package-lock.json'), '{"lockfileVersion":3}')],
  ['store', async p => writeFile(path.join(p, 'lib/chatStore.ts'), 'throw new Error("candidate-executed")')],
  ['auth', async p => writeFile(path.join(p, 'app/api/auth/[...nextauth]/route.ts'), 'throw new Error("candidate-executed")')],
]) {
  test(`unreviewed target cannot claim known compatibility: ${name}`, async t => {
    const f = await targetFixture(t, change);
    await assert.rejects(inspect(f), error => {
      assert.equal(error.code, 'DEPLOYMENT_TARGET_UNSUPPORTED');
      assert.doesNotMatch(error.message, /secret|candidate-executed/);
      assert.ok(error.nextAction);
      return true;
    });
  });
}

test('a different metadata-free historical commit is not implicitly supported', async t => {
  const f = await targetFixture(t);
  await git(f.project, ['switch', '--detach', baseline]);
  await writeFile(path.join(f.project, 'unreviewed.txt'), 'changed');
  await git(f.project, ['add', '.']);
  await git(f.project, ['commit', '-m', 'unreviewed historical']);
  await assert.rejects(inspect({ project: f.project, commit: await git(f.project, ['rev-parse', 'HEAD']) }),
    { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
});

for (const nodeVersion of ['18.0.0', '20.8.0', '26.0.0', '24.0.0-rc.1', 'invalid']) {
  test(`unreviewed Node runtime refuses: ${nodeVersion}`, async () => {
    await assert.rejects(inspectTargetCompatibility({
      project: repository, commit: baseline, nodeVersion, platform: process.platform,
    }), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
  });
}

test('cancelled target inspection does not run Git', async () => {
  await assert.rejects(inspectTargetCompatibility({
    project: repository, commit: baseline, nodeVersion: '24.0.0', platform: 'linux', signal: AbortSignal.abort(),
  }), { name: 'AbortError' });
});

test('nonliteral target refs and unsupported platforms refuse', async () => {
  for (const commit of ['HEAD', '--help', 'f'.repeat(40)]) {
    await assert.rejects(inspect({ project: repository, commit }), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
  }
  await assert.rejects(inspectTargetCompatibility({
    project: repository, commit: baseline, nodeVersion: '24.0.0', platform: 'darwin',
  }), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
});

test('effective authentication configuration is checked without exposing values', () => {
  const result = inspectConfigurationCompatibility({ profile: metadata.configurationProfile, environment });
  assert.equal(result.status, 'configuration-supported');
  assert.deepEqual(result.providers, ['credentials']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-|secret|password/i);
});

for (const [name, patch] of [
  ['secret', { NEXTAUTH_SECRET: '' }],
  ['placeholder', { NEXTAUTH_SECRET: 'change-me-to-a-random-string' }],
  ['url', { NEXTAUTH_URL: 'javascript:private-secret' }],
  ['credential-pair', { ADMIN_PASSWORD: '' }],
  ['github-pair', { GITHUB_CLIENT_ID: 'private-id' }],
  ['github-allowlist', { GITHUB_CLIENT_ID: 'private-id', GITHUB_CLIENT_SECRET: 'private-secret' }],
  ['no-provider', { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }],
  ['nonproduction', { NODE_ENV: 'development' }],
]) {
  test(`invalid effective configuration refuses without secret output: ${name}`, () => {
    assert.throws(() => inspectConfigurationCompatibility({
      profile: metadata.configurationProfile, environment: { ...environment, ...patch },
    }), error => {
      assert.equal(error.code, 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-|fixture-/);
      return true;
    });
  });
}

test('Azure public-client and GitHub admin allowlist fallback match reviewed auth semantics', () => {
  const azure = inspectConfigurationCompatibility({
    profile: metadata.configurationProfile,
    environment: { NEXTAUTH_SECRET: environment.NEXTAUTH_SECRET, NEXTAUTH_URL: environment.NEXTAUTH_URL, AZURE_AD_CLIENT_ID: 'id' },
  });
  assert.deepEqual(azure.providers, ['azure-ad']);
  const github = inspectConfigurationCompatibility({
    profile: metadata.configurationProfile,
    environment: { ...environment, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ADMIN_EMAILS: 'user@example.invalid' },
  });
  assert.deepEqual(github.providers, ['credentials', 'github']);
});

test('target/config partial results cannot authorize transaction downtime', async t => {
  const f = await targetFixture(t);
  const calls = [];
  const operations = Object.fromEntries(['record', 'capacity', 'stop', 'snapshot', 'verifySnapshot', 'rotate',
    'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify'].map(name => [name, async () => calls.push(name)]));
  operations.inspect = async () => ({ exists: true, running: true, owned: true });
  operations.resolveTarget = async () => ({ commit: f.commit });
  operations.admit = async () => ({ target: await inspect(f),
    configuration: inspectConfigurationCompatibility({ profile: metadata.configurationProfile, environment }) });
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /compatibility admission/);
  assert.deepEqual(calls, []);
});
