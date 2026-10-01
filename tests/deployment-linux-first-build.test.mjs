import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { freshSourceInstallationFixture } from './deployment-linux-first-source-fixture.mjs';
import { captureLockOwner, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';
import { linuxNative, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { captureLinuxDeploymentAcceptance } from '../scripts/deployment/linux-deployment-acceptance.mjs';
import { inspectLinuxConfiguration } from '../scripts/deployment/linux-configuration.mjs';
import { publishDeploymentReceipt, readDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';
import { waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';

const execute = promisify(execFile);

async function removeFirstSourceUnit(f) {
  const { unit } = f.installation.identity;
  const fragment = `/etc/systemd/system/${unit}`;
  const inhibition = `${fragment}.d/90-agents-chat-deployment.conf`;
  let owner = f.lock;
  try { owner = captureLockOwner(JSON.parse(await readFile(path.join(f.control, 'lock/owner.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(owner.project, f.project);
  const current = await linuxSystemdProperties(unit, ['LoadState', 'FragmentPath'], { allowMissing: true });
  if (current.LoadState !== 'not-found') {
    assert.equal(current.FragmentPath, fragment);
    await linuxNative('/usr/bin/systemctl', ['--system', 'stop', unit]);
  }
  for (const file of [`/etc/systemd/system/multi-user.target.wants/${unit}`,
    `${inhibition}.${owner.token}.held`, inhibition, fragment]) {
    try { await unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await rmdir(path.dirname(inhibition)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
}

async function firstDeployment(t, completion) {
  const { prepareLinuxFirstBuild } = await import('../scripts/deployment/linux-first-build.mjs');
  const { project, home, controller, installation, control, lock } = await freshSourceInstallationFixture(t);
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
    if (completion === 'retirement') {
      await record('accepted');
      await publishDeploymentReceipt({ control, lock, ...acceptance });
      await active.retire({ acceptance });
      const handoff = JSON.parse(await readFile(path.join(control, 'live-retirement.json'), 'utf8'));
      assert.equal(handoff.version, 4);
      assert.deepEqual(handoff.startup, enabled.identity);
      assert.deepEqual(handoff.files.map(entry => entry.file), [
        `${inhibition}.${lock.token}.held`, path.join(control, 'service-activation.ndjson'),
        path.join(control, 'service-install.ndjson'), path.join(control, 'service-enablement.ndjson'),
      ]);
      assert.equal(await readlink(startupLink), fragment);
      await operation.retire();
      await releaseLock(control, lock);
      assert.equal((await loadState(control)).phase, 'accepted');
      assert.deepEqual((await readDeploymentReceipt(control, project)).identity, acceptance.identity);
      const remaining = await readdir(control);
      assert.equal(remaining.some(name => /^(?:service-|worker-)/.test(name)
        || ['lock', 'live-retirement.json'].includes(name)), false);
      await service.check();
      await waitLinuxReadiness({ service, port: 3010, providers: configuration.providers });
      return;
    }
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
}

for (const completion of ['owned-stop', 'retirement']) {
  test(`fresh installation builds actual source and verifies ${completion} of its ready generation`, {
    skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_BUILD !== '1',
  }, t => firstDeployment(t, completion));
}

async function firstController(t, cancelled) {
  const { runLinuxFirstDeployment } = await import('../scripts/deployment/linux-first-deployment.mjs');
  const f = await freshSourceInstallationFixture(t);
  const { unit, executables } = f.installation.identity;
  const fragment = `/etc/systemd/system/${unit}`;
  const startupLink = `/etc/systemd/system/multi-user.target.wants/${unit}`;
  const phases = [];
  let service;
  try {
    for (const invalid of [{ noInstall: true }, { waitSeconds: 0 }, { deploymentBytes: 0 }]) {
      await assert.rejects(runLinuxFirstDeployment({
        installation: f.installation, control: f.control, lock: f.lock, git: '/usr/bin/git',
        port: 3010, deploymentBytes: 2 * 1024 ** 3, ...invalid,
      }), /Fresh Linux deployment requires/);
      assert.equal(await loadState(f.control), null);
      assert.deepEqual(await readdir(f.control), ['lock']);
    }
    const deploy = () => runLinuxFirstDeployment({
      installation: f.installation, control: f.control, lock: f.lock, git: '/usr/bin/git',
      environment: { HOME: f.home, npm_config_cache: path.join(f.home, '.npm') },
      port: 3010, deploymentBytes: 2 * 1024 ** 3, noPull: true,
      signal: f.controller.signal,
      onProgress({ phase }) {
        phases.push(phase);
        if (cancelled && phase === 'dependencies') f.controller.abort();
      },
    });
    if (cancelled) {
      await assert.rejects(deploy, error => {
        assert.equal(error.code, 'DEPLOYMENT_STAGE_CANCELLED');
        assert.equal(error.backupCreated, false);
        assert.match(error.message, /no previous backup/i);
        return true;
      });
      const state = await loadState(f.control);
      assert.equal(state.phase, 'recovery-required');
      assert.equal(state.priorRuntime, 'absent');
      assert.equal(state.backupId, null);
      assert.equal(state.errorCode, 'DEPLOYMENT_STAGE_CANCELLED');
      await f.installation.checkUninstalled({ signal: null });
      assert.deepEqual(JSON.parse(await readFile(path.join(f.control, 'lock/owner.json'), 'utf8')), f.lock);
      for (const name of ['deployment.json', 'backup', 'service-install.ndjson']) {
        await assert.rejects(lstat(path.join(f.control, name)), { code: 'ENOENT' });
      }
      for (const name of ['.data', '.next', 'node_modules']) {
        await assert.rejects(lstat(path.join(f.project, name)), { code: 'ENOENT' });
      }
      return;
    }
    assert.deepEqual(await deploy(), { status: 'accepted', backupCreated: false });
    assert.deepEqual(phases, ['preflight', 'source-selected', 'dependencies', 'building',
      'configuring', 'activating', 'accepted']);
    const state = await loadState(f.control);
    assert.equal(state.phase, 'accepted');
    assert.equal(state.priorRuntime, 'absent');
    assert.equal(state.backupId, null);
    assert.deepEqual((await readdir(f.control)).sort(), ['deployment.json', 'recovery-engine', 'state.json']);
    const receipt = await readDeploymentReceipt(f.control, f.project);
    assert.equal(receipt.identity.source, state.targetCommit);
    assert.equal(receipt.operationId, f.lock.operationId);
    assert.equal((await lstat(path.join(f.project, 'node_modules'))).uid, 65534);
    assert.equal((await lstat(path.join(f.project, '.next/BUILD_ID'))).uid, 65534);
    assert.ok((await readFile(path.join(f.project, '.next/BUILD_ID'), 'utf8')).trim());
    assert.equal(await readlink(startupLink), fragment);
    assert.equal((await linuxSystemdProperties(unit, ['UnitFileState'])).UnitFileState, 'enabled');
    service = await inspectLinuxService({ unit, project: f.project, npm: executables[0].file, node: executables[1].file });
    assert.equal(receipt.identity.service, createHash('sha256').update(JSON.stringify(service.identity)).digest('hex'));
    const configuration = await inspectLinuxConfiguration({ service, profile: f.installation.configuration.profile });
    assert.deepEqual(configuration.providers, f.installation.configuration.providers);
    await waitLinuxReadiness({ service, port: 3010, providers: configuration.providers });
    await service.check();
  } finally {
    await service?.close();
    await removeFirstSourceUnit(f);
  }
}

for (const cancelled of [false, true]) {
  test(`fresh deployment controller ${cancelled ? 'retains truthful cancellation evidence' : 'accepts the actual ready application'}`, {
    skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_BUILD !== '1',
  }, t => firstController(t, cancelled));
}

test('public deploy installs and accepts an actual fresh application from its own checkout', {
  skip: process.env.DEPLOYMENT_TEST_REAL_FIRST_BUILD !== '1',
}, async t => {
  await import('../scripts/deployment/linux-deploy-command.mjs');
  const uid = Number((await execute('/usr/bin/id', ['-u', 'runner'])).stdout.trim());
  const gid = Number((await execute('/usr/bin/id', ['-g', 'runner'])).stdout.trim());
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  const f = await freshSourceInstallationFixture(t, { unit: 'agents-chat.service', uid, gid });
  const script = path.join(f.project, 'scripts/deploy.sh');
  await releaseLock(f.control, f.lock);
  await rmdir(f.control);
  const dotenv = path.join(f.project, '.env.local');
  await writeFile(dotenv, `${await readFile(dotenv, 'utf8')}npm_config_cache=${path.join(f.home, '.npm')}\n`);
  const options = { cwd: '/', timeout: 1200000, maxBuffer: 16384,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/root', NODE_ENV: 'development' } };
  const invoke = async flags => execute('/usr/bin/bash', [script, '--project-dir', f.project, '--json', ...flags], options);
  let service;
  try {
    assert.equal(JSON.parse((await invoke(['--help'])).stdout).status, 'help');
    assert.deepEqual(JSON.parse((await invoke(['--status'])).stdout),
      { status: 'unmanaged', project: f.project, control: f.control, phase: null });
    for (const flags of [['--wait', '0'], ['--verify'], ['--unknown']]) {
      await assert.rejects(invoke(flags), error => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).status, 'failed');
        return true;
      });
      await assert.rejects(lstat(f.control), { code: 'ENOENT' });
    }
    const result = await invoke(['--no-pull']);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'accepted', backupCreated: false });
    assert.match(result.stderr, /Deployment phase: accepted/);
    const state = await loadState(f.control);
    assert.equal(state.operation, 'deploy');
    assert.equal(state.phase, 'accepted');
    assert.equal(state.priorRuntime, 'absent');
    assert.equal(state.backupId, null);
    assert.deepEqual((await readdir(f.control)).sort(), ['deployment.json', 'recovery-engine', 'state.json']);
    assert.equal(JSON.parse((await invoke(['--status'])).stdout).status, 'idle');
    const { unit, executables } = f.installation.identity;
    service = await inspectLinuxService({ unit, project: f.project, npm: executables[0].file, node: executables[1].file });
    const receipt = await readDeploymentReceipt(f.control, f.project);
    assert.equal(receipt.identity.service, createHash('sha256').update(JSON.stringify(service.identity)).digest('hex'));
    assert.equal(receipt.identity.source, state.targetCommit);
    assert.equal(service.identity.runtime.uid, uid);
    const configuration = await inspectLinuxConfiguration({ service, profile: f.installation.configuration.profile });
    await waitLinuxReadiness({ service, port: 3010, providers: configuration.providers });
    assert.equal((await linuxSystemdProperties(unit, ['UnitFileState'])).UnitFileState, 'enabled');
  } finally {
    await service?.close();
    await removeFirstSourceUnit(f);
  }
});
