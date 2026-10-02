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
const gitOptions = ['-c', 'maintenance.auto=false'];
const git = async (project, args) => (await execute('git', [...gitOptions, '-C', project, ...args])).stdout.trim();
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
  await execute('git', [...gitOptions, 'clone', '--quiet', '--no-hardlinks', '--shared', repository, project]);
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

test('current candidate commit carries a usable reviewed declaration', async () => {
  const result = await inspect({ project: repository, commit: await git(repository, ['rev-parse', 'HEAD']) });
  assert.equal(result.mode, 'declared');
});

test('generation-bound snapshot targets advertise version two without rejecting version-one targets', async t => {
  const f = await targetFixture(t, async p =>
    writeFile(path.join(p, 'scripts/deployment/protocol.json'), '{"version":1,"snapshotVersion":2}'));
  assert.deepEqual((await inspect(f)).protocol, { version: 1, snapshotVersion: 2 });
});

test('Git replacement objects cannot disguise a changed source profile', async t => {
  const f = await targetFixture(t, async p => writeFile(path.join(p, 'lib/chatStore.ts'), 'changed'));
  await git(f.project, ['replace', f.commit, baseline]);
  await assert.rejects(inspect(f), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED' });
});

test('inherited Git redirection does not change the inspected project', async t => {
  const f = await targetFixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.project, 'does-not-exist');
  try { assert.equal((await inspect(f)).commit, f.commit); }
  finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

for (const mode of ['100755', '120000']) {
  test(`declaration is not accepted as an executable or symbolic link: ${mode}`, async t => {
    const f = await targetFixture(t);
    await git(f.project, ['switch', '--detach', f.commit]);
    const file = 'scripts/deployment/compatibility.json';
    const blob = await git(f.project, ['rev-parse', `${f.commit}:${file}`]);
    await git(f.project, ['update-index', '--cacheinfo', `${mode},${blob},${file}`]);
    await git(f.project, ['commit', '-m', 'wrong mode']);
    await assert.rejects(inspect({ project: f.project, commit: await git(f.project, ['rev-parse', 'HEAD']) }),
      { check: 'target-file-type' });
  });
}

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
  assert.deepEqual(result.providers, ['admin-login']);
  assert.doesNotMatch(JSON.stringify(result), /fixture-|secret|password/i);
});

test('configuration accessors are refused without evaluating them', () => {
  let called = false;
  const candidate = { ...environment };
  Object.defineProperty(candidate, 'NEXTAUTH_SECRET', { get() { called = true; throw new Error('secret'); } });
  assert.throws(() => inspectConfigurationCompatibility({
    profile: metadata.configurationProfile, environment: candidate,
  }), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  assert.equal(called, false);
});

test('inherited configuration cannot silently stand in for explicit effective settings', () => {
  assert.throws(() => inspectConfigurationCompatibility({
    profile: metadata.configurationProfile, environment: Object.create(environment),
  }), { check: 'NEXTAUTH_SECRET' });
});

for (const [name, patch] of [
  ['secret', { NEXTAUTH_SECRET: '' }],
  ['placeholder', { NEXTAUTH_SECRET: 'change-me-to-a-random-string' }],
  ['url', { NEXTAUTH_URL: 'javascript:private-secret' }],
  ['url-credentials', { NEXTAUTH_URL: 'https://private-user:private-password@example.invalid' }],
  ['url-fragment', { NEXTAUTH_URL: 'https://example.invalid/#private' }],
  ['credential-pair', { ADMIN_PASSWORD: '' }],
  ['github-pair', { GITHUB_CLIENT_ID: 'private-id' }],
  ['github-allowlist', { GITHUB_CLIENT_ID: 'private-id', GITHUB_CLIENT_SECRET: 'private-secret' }],
  ['no-provider', { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }],
  ['nonproduction', { NODE_ENV: 'development' }],
  ['azure-tenant', { AZURE_AD_CLIENT_ID: 'id', AZURE_AD_TENANT_ID: '' }],
  ['oversized', { NEXTAUTH_SECRET: 'x'.repeat(65537) }],
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
  assert.deepEqual(azure.providers, ['admin-login', 'azure-ad']);
  const github = inspectConfigurationCompatibility({
    profile: metadata.configurationProfile,
    environment: { ...environment, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ADMIN_EMAILS: 'user@example.invalid' },
  });
  assert.deepEqual(github.providers, ['admin-login', 'github']);
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
