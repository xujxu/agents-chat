import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chown, chmod, lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
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
import { linuxNative, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { captureLinuxDeploymentAcceptance } from '../scripts/deployment/linux-deployment-acceptance.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

test('fresh installation builds actual source, activates a new generation and stops that owned generation', {
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
  const controller = new AbortController();
  const installation = await inspectLinuxFirstInstall({
    project, unit: `agents-first-${randomUUID()}.service`, signal: controller.signal,
  });
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
  await assert.rejects(stages.select({ target: { ...target, commit: 'f'.repeat(40) } }), /exact target/i);
  await stages.select({ target });
  await record('dependencies');
  await assert.rejects(stages.npm({ stage: 'build', commit: target.commit }), /phase/i);
  await assert.rejects(stages.npm({
    stage: 'dependencies', commit: target.commit, environment: { NEXTAUTH_SECRET: 'changed' },
  }), /configuration/i);
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
  const { createLinuxFirstUnit } = await import('../scripts/deployment/linux-first-unit.mjs');
  const { enableLinuxFirstUnit } = await import('../scripts/deployment/linux-first-enablement.mjs');
  const { activateLinuxFirstUnit } = await import('../scripts/deployment/linux-first-activation.mjs');
  const { unit } = installation.identity;
  const fragment = `/etc/systemd/system/${unit}`;
  const inhibition = `${fragment}.d/90-agents-chat-deployment.conf`;
  const startupLink = `/etc/systemd/system/multi-user.target.wants/${unit}`;
  let publication;
  let enabled;
  let active;
  let service;
  try {
    await record('configuring');
    const context = { installation, control, lock, signal: controller.signal };
    publication = await createLinuxFirstUnit(context);
    enabled = await enableLinuxFirstUnit({ ...context, publication });
    await record('activating');
    active = await activateLinuxFirstUnit({ ...context, publication, enabled });
    assert.equal(active.status, 'active-unverified');
    assert.equal(active.identity.runtime.unit, unit);
    assert.equal(active.identity.runtime.uid, 65534);
    assert.ok(active.identity.runtime.mainPid > 0);
    assert.match(active.identity.runtime.invocationId, /^[a-f0-9]{32}$/);
    assert.equal((await linuxSystemdProperties(unit, ['UnitFileState'])).UnitFileState, 'enabled');
    service = await inspectLinuxService({
      unit, project, npm: installation.identity.executables[0].file, node: installation.identity.executables[1].file,
    });
    assert.deepEqual(service.identity, active.identity);
    const configuration = await inspectLinuxConfiguration({
      service, profile: installation.configuration.profile, signal: controller.signal,
    });
    assert.deepEqual(configuration.providers, installation.configuration.providers);
    await installation.configuration.check();
    const acceptance = await captureLinuxDeploymentAcceptance({
      service, configuration, source: built.source, artifacts: built.artifacts,
      port: 3010, signal: controller.signal,
    });
    assert.equal(acceptance.identity.source, target.commit);
    for (const key of ['build', 'dependencies', 'config', 'service']) {
      assert.match(acceptance.identity[key], /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(await acceptance.checkAccepted(), acceptance.identity);
    await installation.configuration.check();
    await assert.rejects(readFile(path.join(control, 'deployment.json')), { code: 'ENOENT' });
    controller.abort();
    assert.deepEqual(await active.stopActivated(), { stopped: true, inhibited: true });
    assert.deepEqual(await active.stopActivated(), { stopped: true, inhibited: true });
    const observed = await linuxSystemdProperties(unit, ['MainPID', 'RefuseManualStart']);
    assert.equal(observed.MainPID, '0');
    assert.equal(observed.RefuseManualStart, 'yes');
    const records = (await readFile(path.join(control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records[0].prior.runtime.mainPid, 0);
    assert.equal(records[0].prior.runtime.invocationId, '');
    assert.deepEqual(records.slice(-4).map(entry => entry.phase),
      ['activation-stop-intent', 'activation-stop-inhibited', 'activation-stop-requested', 'activation-stopped']);
  } finally {
    await service?.close();
    await active?.close();
    await enabled?.close();
    await publication?.close();
    if (publication) {
      await linuxNative('/usr/bin/systemctl', ['--system', 'stop', unit]);
      for (const file of [startupLink, `${inhibition}.${lock.token}.held`, inhibition, fragment]) {
        try { await unlink(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rmdir(path.dirname(inhibition));
      await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
    }
  }
});
