import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chown, chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectLinuxFirstInstall } from '../scripts/deployment/linux-first-install.mjs';
import { acquireLock, loadState, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

test('fresh installation builds actual source with owned workers while its systemd unit remains absent', {
  skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_BUILD !== '1',
}, async t => {
  const { prepareLinuxFirstBuild } = await import('../scripts/deployment/linux-first-build.mjs');
  const root = await temporaryDeployment(t);
  await chmod(root, 0o755);
  const project = path.join(root, 'fresh app');
  await execute('/usr/bin/git', ['clone', '--quiet', '--no-hardlinks', repository, project],
    { timeout: 60000, maxBuffer: 16384 });
  await writeFile(path.join(project, '.env.local'), [
    'NEXTAUTH_SECRET=fresh-build-private-secret', 'NEXTAUTH_URL=http://localhost:3010',
    'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=fresh-build-private-password', '',
  ].join('\n'), { mode: 0o600 });
  const own = async directory => {
    await chown(directory, 65534, 65534);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      else if (entry.isFile()) await chown(file, 65534, 65534);
      else throw new Error('Unexpected fresh-source fixture link.');
    }
  };
  await own(project);
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  await chown(home, 65534, 65534);
  const installation = await inspectLinuxFirstInstall({ project, unit: `agents-first-${randomUUID()}.service` });
  const control = path.join(root, '.fresh app.deployment');
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
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  const stages = await prepareLinuxFirstBuild({ installation, control, lock, operation, git: '/usr/bin/git',
    environment: { HOME: home, npm_config_cache: path.join(home, '.npm') } });
  const source = await stages.inspect();
  const target = await stages.resolve({ options: { noPull: true } });
  assert.equal((await inspectTargetCompatibility({
    project, commit: target.commit, nodeVersion: process.versions.node, platform: 'linux',
  })).status, 'target-supported');
  const record = async phase => {
    state = { ...state, previousPhase: state.phase, phase, sourceCommit: source.commit, targetCommit: target.commit };
    await writeState(control, state);
  };
  await assert.rejects(stages.select({ target }), /phase|source-selected/i);
  await record('source-selected');
  await stages.select({ target });
  await record('dependencies');
  await stages.npm({ stage: 'dependencies', commit: target.commit });
  await record('building');
  const built = await stages.npm({ stage: 'build', commit: target.commit });
  await built.source.check();
  await built.artifacts.check();
  await installation.checkUninstalled();
  assert.ok((await readFile(path.join(project, '.next/BUILD_ID'), 'utf8')).trim());
  assert.equal((await lstat(path.join(project, 'node_modules'))).uid, 65534);
  assert.equal((await lstat(path.join(project, '.next/BUILD_ID'))).uid, 65534);
  await assert.rejects(readdir(path.join(control, 'backup')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(control, 'deployment.json')), { code: 'ENOENT' });
  assert.equal((await loadState(control)).phase, 'building');
  await operation.seal();
  assert.equal((await readWorkerOperation(control)).at(-1).phase, 'sealed');
});
