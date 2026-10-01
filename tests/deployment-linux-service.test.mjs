import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { chmod, chown, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import * as serviceInspection from '../scripts/deployment/linux-service-inspection.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { hasFailedLinuxActivation } from '../scripts/deployment/linux-service-activation.mjs';
import { prepareLinuxSourceBuild } from '../scripts/deployment/linux-source-build.mjs';
import { acquireLock, loadState, writeState, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { runDeployment } from '../scripts/deployment/transaction.mjs';
import { fixture, ready, systemctl, node, npm, quote } from './deployment-linux-service-fixture.mjs';

const execute = promisify(execFile);
const native = (file, args) => execute(file, args, { timeout: 20000, maxBuffer: 8192 });

test('queued new activation does not inherit old stopped-generation failure', () => {
  const prior = 'a'.repeat(32);
  const observed = { ActiveState: 'failed', SubState: 'failed', MainPID: '0',
    InvocationID: prior, Job: '1824', Result: 'timeout' };
  assert.equal(hasFailedLinuxActivation(observed, prior), false);
  for (const changes of [{ Job: '' }, { Job: '0' }, { Job: 'invalid' },
    { InvocationID: 'b'.repeat(32) }, { MainPID: '123' }, { SubState: 'auto-restart' }]) {
    assert.equal(hasFailedLinuxActivation({ ...observed, ...changes }, prior), true);
  }
  assert.equal(hasFailedLinuxActivation({ ...observed, ActiveState: 'activating', SubState: 'start' }, prior), false);
});

test('retains actual installed npm service sources and cgroup without stopping its detached descendants', async t => {
  const f = await fixture(t);
  const child = await ready(f);
  const before = (await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout;
  const service = await inspectLinuxService(f);
  try {
    assert.equal(service.identity.runtime.project, f.project);
    assert.equal(service.identity.sources.length, 1);
    assert.equal(service.identity.sources[0].path, f.fragment);
    assert.match(service.identity.sources[0].sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => { service.identity.configuration.state.Restart = 'no'; }, TypeError);
    assert.throws(() => { service.identity.configuration.command.args.push('--foreign'); }, TypeError);
    assert.throws(() => { service.identity.executables[0].file = '/bin/false'; }, TypeError);
    assert.equal((await service.check()).populated, true);
    assert.equal((await readFile(`/proc/${child}/cgroup`, 'utf8')).trim(), `0::/system.slice/${f.unit}`);
    assert.equal((await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout, before);
  } finally { await service.close(); }
  await assert.rejects(service.check(), /closed/i);
});

test('does not mistake a Node service in the same directory for the expected npm service', async t => {
  const f = await fixture(t, { command: `${quote(node)} server.cjs` });
  await ready(f);
  await assert.rejects(inspectLinuxService(f), /command|ExecStart/i);
  await assert.rejects(serviceInspection.inspectInstalledLinuxService({ unit: f.unit, project: f.project }), /npm|command|ExecStart/i);
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
});

test('discovers installed npm and actual Node without controller PATH or caller executable guesses', async t => {
  const f = await fixture(t, { nonroot: true });
  await ready(f);
  const before = (await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout;
  const service = await serviceInspection.inspectInstalledLinuxService({ unit: f.unit, project: f.project });
  try {
    assert.equal(service.identity.runtime.uid, 65534);
    assert.equal(service.identity.executables[0].file, f.npm);
    assert.equal(service.identity.executables[1].target, await fs.realpath(f.node));
    await service.check();
    assert.equal((await systemctl('show', f.unit, '--property=MainPID,InvocationID')).stdout, before);
  } finally { await service.close(); }
  await assert.rejects(serviceInspection.inspectInstalledLinuxService({
    unit: f.unit, project: path.dirname(f.project),
  }), /project|directory/i);
  await systemctl('stop', f.unit);
  const stopped = (await systemctl('show', f.unit, '--property=ActiveState,MainPID,InvocationID')).stdout;
  await assert.rejects(serviceInspection.inspectInstalledLinuxService({ unit: f.unit, project: f.project }), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check: 'NEXTAUTH_SECRET',
  });
  assert.equal((await systemctl('show', f.unit, '--property=ActiveState,MainPID,InvocationID')).stdout, stopped);
});

test('retains non-root installed npm identity and rejects a different expected Node executable', async t => {
  const f = await fixture(t, { nonroot: true });
  await ready(f);
  const service = await inspectLinuxService(f);
  try {
    assert.equal(service.identity.runtime.uid, 65534);
    assert.equal(service.identity.runtime.gid, 65534);
    assert.equal((await service.check()).populated, true);
  } finally { await service.close(); }
  await assert.rejects(inspectLinuxService({ ...f, node: '/usr/bin/true' }), /executable|identity/i);
});

test('rejects extra npm arguments and privileged command prefixes', async t => {
  for (const command of [`${quote(npm)} start -- --foreign`, `+${quote(npm)} start`]) {
    const f = await fixture(t, { command });
    await ready(f);
    await assert.rejects(inspectLinuxService(f), /command|ExecStart|flags/i);
    await assert.rejects(serviceInspection.inspectInstalledLinuxService({ unit: f.unit, project: f.project }), /command|ExecStart|flags/i);
  }
});

test('source mutation and byte-identical replacement invalidate retained service authority', async t => {
  for (const replace of [false, true]) {
    const f = await fixture(t);
    await ready(f);
    const service = await inspectLinuxService(f);
    try {
      if (replace) await rename(f.fragment, `${f.fragment}.old`);
      await writeFile(f.fragment, replace ? f.bytes : `${f.bytes}\n# changed\n`, { mode: 0o644 });
      if (replace) await unlink(`${f.fragment}.old`);
      await assert.rejects(service.check(), /source|file|configuration/i);
    } finally { await service.close(); }
  }
});

test('effective drop-ins are retained and changing one is not silently accepted', async t => {
  const f = await fixture(t, { dropIn: 'RestartSec=2s' });
  await ready(f);
  const service = await inspectLinuxService(f);
  try {
    assert.equal(service.identity.sources.length, 2);
    await writeFile(f.dropFile, '[Service]\nRestartSec=3s\n');
    await assert.rejects(service.check(), /source|file|configuration/i);
  } finally { await service.close(); }
});

test('a new service invocation cannot reuse the old inspection', async t => {
  const f = await fixture(t);
  await ready(f);
  const service = await inspectLinuxService(f);
  try {
    await systemctl('restart', f.unit);
    await assert.rejects(service.check(), /identity|generation|configuration/i);
  } finally { await service.close(); }
});

test('unsafe stop policy and writable unit sources are rejected before service mutation', async t => {
  for (const settings of ['KillMode=process', 'Delegate=yes', 'ExecStop=/usr/bin/true', 'RestartForceExitStatus=SIGKILL']) {
    const f = await fixture(t, { settings });
    await ready(f);
    await assert.rejects(inspectLinuxService(f), /policy|hook|delegat|configuration/i);
  }
  const f = await fixture(t);
  await ready(f);
  await chmod(f.fragment, 0o666);
  await assert.rejects(inspectLinuxService(f), /source|permission|writable/i);
});

async function stopFixture(t, options) {
  const f = await fixture(t, options);
  await ready(f);
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const state = {
    version: 1, operationId: lock.operationId, project: f.project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
    backupId: null, priorRuntime: 'running', runtimeIdentity: f.unit,
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  await writeState(control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
  return { ...f, control, lock, inhibition: `/etc/systemd/system/${f.unit}.d/90-agents-chat-deployment.conf` };
}

test('installed non-root service identity governs source selection and npm build only while inhibited', async t => {
  const f = await stopFixture(t, { nonroot: true });
  const git = '/usr/bin/git';
  const setup = async (...args) => (await native(git, ['-c', `safe.directory=${f.project}`, '-C', f.project, ...args])).stdout.trim();
  const pkg = JSON.parse(await readFile(path.join(f.project, 'package.json'), 'utf8'));
  pkg.name = 'installed-build-fixture';
  pkg.version = '1.0.0';
  pkg.scripts.build = 'node build.cjs';
  pkg.scripts.preinstall = 'node -e "require(\'node:fs\').writeFileSync(\'dependency-environment\',process.env.DEPLOYMENT_BUILD_VALUE)"';
  await writeFile(path.join(f.project, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(f.project, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } },
  }));
  await writeFile(path.join(f.project, '.gitignore'), 'ready\nwrites\n.npm/\n.next/\nnode_modules/\nartifact\ndependency-environment\n');
  await writeFile(path.join(f.project, 'build.cjs'),
    `const fs=require('node:fs');fs.mkdirSync('.next',{recursive:true});fs.mkdirSync('node_modules',{recursive:true});
fs.writeFileSync('.next/BUILD_ID',process.env.DEPLOYMENT_BUILD_VALUE);fs.writeFileSync('.next/app.js','compiled application');
fs.writeFileSync('artifact',String(process.getuid()));`);
  await writeFile(path.join(f.project, 'source.txt'), 'old source\n');
  await setup('init', '--initial-branch=main');
  await setup('config', 'user.name', 'Deployment fixture');
  await setup('config', 'user.email', 'fixture@example.invalid');
  await setup('add', '.');
  await setup('commit', '-m', 'old');
  const old = await setup('rev-parse', 'HEAD');
  await writeFile(path.join(f.project, 'source.txt'), 'new source\n');
  await setup('commit', '-am', 'new');
  const next = await setup('rev-parse', 'HEAD');
  await setup('switch', '--detach', old);
  const assignOwner = async directory => {
    await chown(directory, 65534, 65534);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await assignOwner(file);
      else if (entry.isFile()) await chown(file, 65534, 65534);
      else throw new Error('Unexpected source fixture link.');
    }
  };
  await assignOwner(f.project);
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  const saved = await saveWorkerEngine({ control: f.control, project: f.project, operationId: f.lock.operationId,
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
  const operation = await createWorkerOperation({ control: f.control, lock: f.lock, saved });
  t.after(() => operation.close());
  const environment = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: service.identity.runtime.home,
    USER: 'nobody', LOGNAME: 'nobody', NODE_ENV: 'production', npm_config_cache: path.join(f.project, '.npm'),
  };
  const stages = await prepareLinuxSourceBuild({ service, operation, git, environment });
  const buildEnvironment = { ...environment, DEPLOYMENT_BUILD_VALUE: 'installed-build' };
  assert.equal((await stages.inspect()).commit, old);
  const target = await stages.resolve({ options: { revision: next } });
  await assert.rejects(stages.select({ target }), /stopped/i);
  assert.equal(await setup('rev-parse', 'HEAD'), old);
  const stopped = await stopLinuxService(f);
  t.after(() => stopped.close());
  assert.equal((await stages.select({ target, stopped })).commit, next);
  await assert.rejects(stages.npm({ stage: 'dependencies', commit: old, stopped }), /commit/i);
  await stages.npm({ stage: 'dependencies', commit: next, stopped, environment: buildEnvironment });
  const built = await stages.npm({ stage: 'build', commit: next, stopped, environment: buildEnvironment });
  assert.equal(built.sourceCommit, next);
  assert.equal(built.source.record.commit, next);
  await built.source.check();
  assert.equal(built.artifacts.identity.buildId, 'installed-build');
  assert.equal(await readFile(path.join(f.project, 'dependency-environment'), 'utf8'), 'installed-build');
  await built.artifacts.check();
  assert.equal(await readFile(path.join(f.project, 'artifact'), 'utf8'), '65534');
  assert.equal((await fs.lstat(path.join(f.project, 'artifact'))).uid, 65534);
  assert.equal(await readFile(path.join(f.project, 'source.txt'), 'utf8'), 'new source\n');
  assert.deepEqual(await stopped.checkStopped(), { stopped: true, inhibited: true });
  await writeFile(path.join(f.project, '.next/app.js'), 'changed after build');
  await assert.rejects(built.artifacts.check(), /artifact|changed/i);
  await operation.seal();
});

test('durable inhibition stops the original service and detached writer before granting snapshot admission', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  try {
    assert.deepEqual(await stopped.checkStopped(), { stopped: true, inhibited: true });
    const bytes = await readFile(path.join(f.project, 'writes'));
    await delay(150);
    assert.deepEqual(await readFile(path.join(f.project, 'writes')), bytes);
    await assert.rejects(systemctl('start', f.unit), /refus|manual/i);
    await systemctl('daemon-reload');
    await assert.rejects(systemctl('start', f.unit), /refus|manual/i);
    const receipts = (await readFile(path.join(f.control, 'service-stop.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(receipts.map(record => record.phase), ['intent', 'inhibited', 'stop-requested', 'stopped']);
    await assert.rejects(releaseLock(f.control, f.lock), /service/i);
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  } finally { await stopped.close(); }
  assert.match(await readFile(f.inhibition, 'utf8'), /RefuseManualStart=yes/);
});

test('dependency activation cannot bypass persistent inhibition', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  try {
    const requester = `agents-requester-${randomUUID()}.service`;
    t.after(async () => { await systemctl('stop', requester); });
    await native('/usr/bin/systemd-run', ['--quiet', '--unit', requester,
      '--property=Type=exec', '--property=RemainAfterExit=yes', `--property=Wants=${f.unit}`,
      `--property=After=${f.unit}`, '--', '/usr/bin/true']);
    assert.deepEqual(await stopped.checkStopped(), { stopped: true, inhibited: true });
    assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
  } finally { await stopped.close(); }
});

test('existing inhibition is never overwritten and foreign locks never stop a running service', async t => {
  const f = await stopFixture(t);
  await assert.rejects(stopLinuxService({ ...f, lock: { ...f.lock, token: randomUUID() } }));
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
  await mkdir(path.dirname(f.inhibition));
  await writeFile(f.inhibition, '# owned by someone else\n');
  await systemctl('daemon-reload');
  await assert.rejects(stopLinuxService(f));
  assert.equal(await readFile(f.inhibition, 'utf8'), '# owned by someone else\n');
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
});

test('inhibition, journal or lock replacement poisons stopped-state authority without restarting anything', async t => {
  for (const kind of ['inhibition', 'lock', 'journal']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    try {
      const file = kind === 'lock' ? path.join(f.control, 'lock', 'owner.json')
        : kind === 'journal' ? path.join(f.control, 'service-stop.ndjson') : f.inhibition;
      const bytes = await readFile(file);
      await rename(file, `${file}.old`);
      await writeFile(file, bytes, { mode: 0o600 });
      await unlink(`${file}.old`);
      await assert.rejects(stopped.checkStopped(), error => error.recoveryAllowed === false);
      assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
    } finally { await stopped.close(); }
  }
});

test('actual controller death retains inhibition and blocked status both before and after stop', async t => {
  for (const phase of ['stop-requested', 'stopped']) {
    const f = await fixture(t);
    await ready(f);
    const control = path.join(path.dirname(f.project), 'control');
    await mkdir(control, { mode: 0o700 });
    const child = fork(new URL('./deployment-service-stop-child.mjs', import.meta.url),
      [control, f.project, f.unit, f.npm, f.node, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Stop controller did not reach receipt: ${diagnostic}`)), 45000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Stop controller exited ${code}: ${diagnostic}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.kill('SIGKILL');
    await exited;
    assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
    await assert.rejects(acquireLock(control, { project: f.project, operationId: randomUUID() }), /service/i);
    const active = (await systemctl('show', f.unit, '--property=ActiveState', '--value')).stdout.trim();
    if (phase === 'stop-requested') assert.equal(active, 'active');
    else assert.ok(['inactive', 'failed'].includes(active));
    await systemctl('daemon-reload');
    await assert.rejects(systemctl('start', f.unit), /manual|refus/i);
    if (phase === 'stop-requested') {
      const mainPid = Number((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim());
      assert.ok(Number.isSafeInteger(mainPid) && mainPid > 1);
      assert.equal((await systemctl('show', f.unit, '--property=Restart', '--value')).stdout.trim(), 'no');
      process.kill(mainPid, 'SIGKILL');
      let restartDenied = false;
      let observed = '';
      for (let attempt = 0; attempt < 200; attempt++) {
        const { stdout } = await systemctl('show', f.unit, '--property=Restart,MainPID,ActiveState,NRestarts,Result');
        observed = stdout;
        if (/^Restart=no$/m.test(stdout) && /^NRestarts=0$/m.test(stdout) && /^MainPID=0$/m.test(stdout)
          && /^ActiveState=(inactive|failed)$/m.test(stdout)) {
          restartDenied = true;
          break;
        }
        await delay(25);
      }
      assert.equal(restartDenied, true, `Automatic on-failure restart must remain disabled: ${observed}`);
      await delay(1500);
      const after = (await systemctl('show', f.unit, '--property=Restart,MainPID,ActiveState,NRestarts')).stdout;
      assert.match(after, /^MainPID=0$/m);
      assert.match(after, /^NRestarts=0$/m);
      assert.match(after, /^ActiveState=(inactive|failed)$/m);
    }
  }
});

test('failed stop retains durable inhibition and never claims a stopped service', async t => {
  const f = await stopFixture(t, { settings: '[Unit]\nRefuseManualStop=yes' });
  await assert.rejects(stopLinuxService(f), error => error.recoveryAllowed === false);
  assert.match(await readFile(f.inhibition, 'utf8'), /RefuseManualStart=yes/);
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
  const receipts = (await readFile(path.join(f.control, 'service-stop.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(receipts.map(record => record.phase), ['intent', 'inhibited', 'stop-requested']);
  assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
});

test('restoring the original inhibitor cannot authorize a replacement service generation', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  try {
    const original = `${f.inhibition}.held`;
    await rename(f.inhibition, original);
    await systemctl('daemon-reload');
    await systemctl('start', f.unit);
    await rename(original, f.inhibition);
    await systemctl('daemon-reload');
    await assert.rejects(stopped.checkStopped(), error => error.recoveryAllowed === false);
    assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
  } finally { await stopped.close(); }
});

test('receipt flush failure never crosses the next manager mutation and retains blocked evidence', async t => {
  for (const phase of ['intent', 'inhibited']) {
    const f = await stopFixture(t);
    const journalPath = path.join(f.control, 'service-stop.ndjson');
    const nativeOpen = fs.open;
    let injected = false;
    fs.open = async function (file, ...args) {
      const handle = await nativeOpen(file, ...args);
      if (file === journalPath) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          const text = await readFile(file, 'utf8');
          if (text.trim() && JSON.parse(text.trim().split('\n').at(-1)).phase === phase) {
            injected = true;
            throw new Error('Injected service receipt flush failure.');
          }
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(stopLinuxService(f), error => error.recoveryAllowed === false); }
    finally { fs.open = nativeOpen; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
    if (phase === 'intent') await assert.rejects(readFile(f.inhibition), { code: 'ENOENT' });
    else {
      assert.match(await readFile(f.inhibition, 'utf8'), /RefuseManualStart=yes/);
      await assert.rejects(systemctl('start', f.unit), /manual|refus/i);
    }
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  }
});

async function advanceState(f, phases) {
  for (const phase of phases) {
    const state = await loadState(f.control);
    await writeState(f.control, { ...state, phase, previousPhase: state.phase });
  }
}

test('prior runtime activation restores only the original service policy without installing or building', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  try {
    const manifest = JSON.parse(await readFile(path.join(f.project, 'package.json'), 'utf8'));
    manifest.scripts.preinstall = manifest.scripts.build = 'exit 71';
    await writeFile(path.join(f.project, 'package.json'), JSON.stringify(manifest));
    const active = await stopped.activate({ purpose: 'prior-runtime' });
    assert.equal(active.status, 'active-unverified');
    assert.equal(active.identity.runtime.project, f.project);
    assert.equal((await systemctl('show', f.unit, '--property=Restart', '--value')).stdout.trim(), 'on-failure');
    await assert.rejects(readFile(f.inhibition), { code: 'ENOENT' });
    await assert.rejects(stopped.activate({ purpose: 'prior-runtime' }));
    await assert.rejects(releaseLock(f.control, f.lock), /service/i);
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  } finally { await stopped.close(); }
});

test('deployment activation requires explicit activating state and returns a new verified service generation', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  const initial = JSON.parse((await readFile(path.join(f.control, 'service-stop.ndjson'), 'utf8')).split('\n')[0]);
  try {
    await advanceState(f, ['copying', 'rotating', 'backup-ready', 'source-selected',
      'dependencies', 'building', 'configuring', 'activating']);
    const active = await stopped.activate({ purpose: 'deployment' });
    assert.equal(active.status, 'active-unverified');
    assert.notEqual(active.identity.runtime.invocationId, initial.service.runtime.invocationId);
    assert.equal((await loadState(f.control)).phase, 'activating');
  } finally { await stopped.close(); }
});

test('invalid activation purpose, wrong state and unresolved worker evidence retain inhibition', async t => {
  for (const mode of ['purpose', 'state', 'workers', 'late-prior']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    try {
      if (mode === 'workers') await writeFile(path.join(f.control, 'worker-foreign.ndjson'), '{}');
      if (mode === 'late-prior') await advanceState(f, ['copying', 'rotating', 'backup-ready', 'source-selected']);
      await assert.rejects(stopped.activate({ purpose: mode === 'purpose' ? 'anything'
        : mode === 'state' ? 'deployment' : 'prior-runtime' }));
      assert.match(await readFile(f.inhibition, 'utf8'), /Restart=no/);
      assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
    } finally { await stopped.close(); }
  }
});

test('activation admits real settled workers only after their operation is sealed', async t => {
  for (const sealed of [false, true]) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    const saved = await saveWorkerEngine({ control: f.control, project: f.project, operationId: f.lock.operationId,
      source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
    const workers = await createWorkerOperation({ control: f.control, lock: f.lock, saved });
    try {
      await workers.run({ workerId: randomUUID(), command: {
        file: node, args: ['-e', 'process.exit(0)'], cwd: f.project, env: { PATH: '/usr/bin:/bin', HOME: '/root' },
      }, runtime: { uid: 0, gid: 0 } });
      if (sealed) {
        await workers.seal();
        assert.equal((await stopped.activate({ purpose: 'prior-runtime' })).status, 'active-unverified');
      } else {
        await assert.rejects(stopped.activate({ purpose: 'prior-runtime' }));
        assert.match(await readFile(f.inhibition, 'utf8'), /Restart=no/);
      }
    } finally { await workers.close(); await stopped.close(); }
  }
});

test('failed native startup restores the original inhibitor without claiming application recovery', async t => {
  const f = await stopFixture(t, { nonroot: true });
  const stopped = await stopLinuxService(f);
  const original = await fs.stat(f.inhibition);
  try {
    await chmod(f.project, 0o000);
    await assert.rejects(stopped.activate({ purpose: 'prior-runtime' }), error => error.recoveryAllowed === false);
    const restored = await fs.stat(f.inhibition);
    assert.equal(restored.ino, original.ino);
    assert.equal(restored.dev, original.dev);
    assert.equal(restored.nlink, 1);
    assert.equal((await systemctl('show', f.unit, '--property=Restart', '--value')).stdout.trim(), 'no');
    const receipts = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(receipts.at(-1).phase, 'reinhibited');
    assert.equal(receipts.some(record => record.phase === 'started'), false);
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  } finally { await chmod(f.project, 0o755); await stopped.close(); }
});

test('controller death during staged, uninhibited and started activation retains explicit recovery evidence', async t => {
  for (const phase of ['staged', 'uninhibited', 'started']) {
    const f = await fixture(t);
    await ready(f);
    const control = path.join(path.dirname(f.project), 'control');
    await mkdir(control, { mode: 0o700 });
    const child = fork(new URL('./deployment-service-stop-child.mjs', import.meta.url),
      [control, f.project, f.unit, f.npm, f.node, `activation-${phase}`],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Activation controller did not reach ${phase}: ${diagnostic}`)), 45000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Activation controller exited ${code}: ${diagnostic}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.kill('SIGKILL');
    await exited;
    const records = (await readFile(path.join(control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    const record = records.at(-1);
    assert.equal(record.phase, phase);
    assert.equal((await fs.stat(record.held)).nlink, phase === 'staged' ? 2 : 1);
    if (phase === 'staged') await assert.rejects(systemctl('start', f.unit), /manual|refus/i);
    const mainPid = Number((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim());
    assert.equal(mainPid > 0, phase === 'started');
    assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
    await assert.rejects(acquireLock(control, { project: f.project, operationId: randomUUID() }), /service/i);
  }
});

test('activation receipt flush failure cannot grant startup or erase uncertain evidence', async t => {
  for (const phase of ['intent', 'staged', 'start-requested']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    const nativeOpen = fs.open;
    let injected = false;
    fs.open = async function (file, ...args) {
      const handle = await nativeOpen(file, ...args);
      if (file === path.join(f.control, 'service-activation.ndjson')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          const text = await readFile(file, 'utf8');
          if (text.trim() && JSON.parse(text.trim().split('\n').at(-1)).phase === phase) {
            injected = true;
            throw new Error('Injected activation receipt flush failure.');
          }
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(stopped.activate({ purpose: 'prior-runtime' }), error => error.recoveryAllowed === false); }
    finally { fs.open = nativeOpen; syncBuiltinESMExports(); await stopped.close(); }
    assert.equal(injected, true);
    assert.equal((await systemctl('show', f.unit, '--property=MainPID', '--value')).stdout.trim(), '0');
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
    const records = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.some(record => record.phase === 'started'), false);
  }
});

async function activateDeployment(f, stopped) {
  await advanceState(f, ['copying', 'rotating', 'backup-ready', 'source-selected',
    'dependencies', 'building', 'configuring', 'activating']);
  return stopped.activate({ purpose: 'deployment' });
}

test('accepted service maintenance retires exactly its files without touching the running app, state or backup', async t => {
  const f = await stopFixture(t);
  const stopped = await stopLinuxService(f);
  try {
    await mkdir(path.join(f.control, 'backup'));
    await writeFile(path.join(f.control, 'backup', 'sentinel'), 'retained complete backup');
    const active = await activateDeployment(f, stopped);
    await advanceState(f, ['accepted']);
    const state = await readFile(path.join(f.control, 'state.json'));
    const activation = JSON.parse((await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).split('\n')[0]);
    await stopped.retire();
    assert.deepEqual((await fs.readdir(f.control)).sort(), ['backup', 'live-retirement.json', 'lock', 'state.json']);
    await assert.rejects(readFile(activation.held), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained complete backup');
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(), active.identity.runtime.invocationId);
    await releaseLock(f.control, f.lock);
    const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
    await releaseLock(f.control, next);
    await assert.rejects(stopped.retire());
  } finally { await stopped.close(); }
});

test('service retirement requires acceptance of this deployment, not just an active service or prior-runtime restart', async t => {
  for (const mode of ['unaccepted', 'prior', 'restarted', 'replaced']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    try {
      if (mode === 'prior') await stopped.activate({ purpose: 'prior-runtime' });
      else {
        await activateDeployment(f, stopped);
        if (mode !== 'unaccepted') await advanceState(f, ['accepted']);
      }
      if (mode === 'restarted') await systemctl('restart', f.unit);
      if (mode === 'replaced') {
        const file = path.join(f.control, 'service-activation.ndjson');
        const bytes = await readFile(file);
        await rename(file, `${file}.old`);
        await writeFile(file, bytes, { mode: 0o600 });
        await unlink(`${file}.old`);
      }
      await assert.rejects(stopped.retire(), error => error.recoveryAllowed === false);
      assert.ok((await fs.readdir(f.control)).includes('service-stop.ndjson'));
      await assert.rejects(releaseLock(f.control, f.lock), /service/i);
    } finally { await stopped.close(); }
  }
});

test('live unlock refuses changed state, service generation and unrelated evidence', async t => {
  for (const fault of ['state', 'runtime', 'foreign-worker', 'recovery']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    try {
      await activateDeployment(f, stopped);
      await advanceState(f, ['accepted']);
      await stopped.retire();
      const receipt = await readFile(path.join(f.control, 'live-retirement.json'));
      if (fault === 'state') {
        const state = await loadState(f.control);
        await writeFile(path.join(f.control, 'state.json'), JSON.stringify({ ...state, targetCommit: 'd'.repeat(40) }));
      }
      if (fault === 'runtime') await systemctl('restart', f.unit);
      if (fault === 'foreign-worker') await writeFile(path.join(f.control, 'worker-foreign'), 'untouched');
      if (fault === 'recovery') await mkdir(path.join(f.control, 'recovery-lock'), { mode: 0o700 });
      await assert.rejects(releaseLock(f.control, f.lock));
      assert.deepEqual(await readFile(path.join(f.control, 'live-retirement.json')), receipt);
      assert.equal(JSON.parse(await readFile(path.join(f.control, 'lock', 'owner.json'))).token, f.lock.token);
      assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
    } finally { await stopped.close(); }
  }
});

test('service retirement permits worker retirement and the same fixed slots can run a second operation', async t => {
  const f = await stopFixture(t);
  let lock = f.lock;
  for (let iteration = 0; iteration < 2; iteration++) {
    if (iteration) {
      lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
      const previous = await loadState(f.control);
      await writeState(f.control, { ...previous, operationId: lock.operationId, phase: 'preflight', previousPhase: null,
        startedAt: lock.createdAt, updatedAt: lock.createdAt });
      await advanceState(f, ['stopped']);
    }
    const stopped = await stopLinuxService({ ...f, lock });
    const saved = await saveWorkerEngine({ control: f.control, project: f.project, operationId: lock.operationId,
      source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
    const workers = await createWorkerOperation({ control: f.control, lock, saved });
    try {
      await workers.run({ workerId: randomUUID(), command: {
        file: node, args: ['-e', 'process.exit(0)'], cwd: f.project, env: { PATH: '/usr/bin:/bin', HOME: '/root' },
      }, runtime: { uid: 0, gid: 0 } });
      await workers.seal();
      await activateDeployment(f, stopped);
      await advanceState(f, ['accepted']);
      await stopped.retire();
      await workers.retire();
      await releaseLock(f.control, lock);
      assert.deepEqual(await fs.readdir(f.control), ['state.json']);
    } finally { await workers.close(); await stopped.close(); }
  }
});

test('partial service retirement retains durable intent and never unlocks or stops the accepted app', async t => {
  for (const fault of ['intent-flush', 'second-unlink', 'marker-unlink', 'state-drift', 'handle-close']) {
    const f = await stopFixture(t);
    const stopped = await stopLinuxService(f);
    const active = await activateDeployment(f, stopped);
    await advanceState(f, ['accepted']);
    const marker = path.join(f.control, 'service-retirement.json');
    const nativeOpen = fs.open;
    const nativeUnlink = fs.unlink;
    const nativeRename = fs.rename;
    let injected = false;
    let closeArmed = false;
    fs.open = async function (file, ...args) {
      const handle = await nativeOpen(file, ...args);
      if (fault === 'handle-close' && !closeArmed && file === marker && args[0] !== 'wx') {
        closeArmed = true;
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); injected = true; throw new Error('Injected retirement handle close failure.'); };
      }
      if (file === marker && fault === 'intent-flush' && args[0] === 'wx') {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); injected = true; throw new Error('Injected intent flush failure.'); };
      }
      return handle;
    };
    fs.unlink = async function (file) {
      if (fault === 'second-unlink' && file === path.join(f.control, 'service-activation.ndjson')) {
        injected = true;
        throw new Error('Injected service retirement unlink failure.');
      }
      await nativeUnlink(file);
      if (fault === 'state-drift' && String(file).endsWith('.held')) {
        const state = await loadState(f.control);
        await writeFile(path.join(f.control, 'state.json'), `${JSON.stringify({ ...state, targetCommit: 'c'.repeat(40) })}\n`);
        injected = true;
      }
    };
    fs.rename = async (from, to) => {
      if (fault === 'marker-unlink' && from === marker) {
        injected = true;
        throw new Error('Injected service retirement publication failure.');
      }
      return nativeRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(stopped.retire(), error => error.recoveryAllowed === false); }
    finally { fs.open = nativeOpen; fs.unlink = nativeUnlink; fs.rename = nativeRename; syncBuiltinESMExports(); await stopped.close(); }
    assert.equal(injected, true);
    assert.ok((await fs.readdir(f.control)).includes('service-retirement.json'));
    await assert.rejects(releaseLock(f.control, f.lock), /service/i);
    assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(), active.identity.runtime.invocationId);
    assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
  }
});

test('actual retirement-controller death after first unlink preserves the running app and blocks reentry', async t => {
  const f = await fixture(t);
  await ready(f);
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const child = fork(new URL('./deployment-service-stop-child.mjs', import.meta.url),
    [control, f.project, f.unit, f.npm, f.node, 'retirement-unlink'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Retirement controller did not reach unlink: ${diagnostic}`)), 45000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Retirement controller exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  child.kill('SIGKILL');
  await exited;
  const intent = JSON.parse(await readFile(path.join(control, 'service-retirement.json'), 'utf8'));
  await assert.rejects(readFile(intent.files[0].file), { code: 'ENOENT' });
  assert.ok((await fs.readdir(control)).includes('service-activation.ndjson'));
  assert.equal((await systemctl('show', f.unit, '--property=InvocationID', '--value')).stdout.trim(), intent.runtime.runtime.invocationId);
  assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
  await assert.rejects(acquireLock(control, { project: f.project, operationId: randomUUID() }), /service/i);
});

for (const recoveryMode of ['no-workers', 'workers', 'verify-failure']) {
test(`real backup failure recovers the prior service without accepting the update: ${recoveryMode}`, async t => {
  const f = await fixture(t);
  await ready(f);
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  let stopped;
  let active;
  let workers;
  const failure = Object.assign(new Error('actual transaction backup fixture failed'), { code: 'BACKUP_FAILED' });
  const healthFailure = new Error('prior-runtime verification failed');
  const forbidden = async () => { throw new Error('Post-backup mutations must not run.'); };
  try {
    await assert.rejects(runDeployment({ operation: 'update', waitSeconds: 0 }, {
      inspect: async () => ({ exists: true, running: true, owned: true }),
      resolveTarget: async () => ({ commit: 'b'.repeat(40) }),
      admit: async () => ({ compatibility: 'passed', current: null }),
      capacity: async () => {},
      record: async (phase, context) => {
        const previous = await loadState(control);
        await writeState(control, {
          version: 1, operationId: lock.operationId, project: f.project, operation: 'update', phase,
          previousPhase: previous?.phase ?? null, sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
          backupId: null, priorRuntime: 'running', runtimeIdentity: f.unit,
          startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
        });
      },
      stop: async () => { stopped = await stopLinuxService({ ...f, control, lock }); },
      snapshot: async () => {
        if (recoveryMode === 'workers') {
          const saved = await saveWorkerEngine({ control, project: f.project, operationId: lock.operationId,
            source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
          workers = await createWorkerOperation({ control, lock, saved });
          await workers.run({ workerId: randomUUID(), command: {
            file: node, args: ['-e', 'process.exit(0)'], cwd: f.project, env: { PATH: '/usr/bin:/bin', HOME: '/root' },
          }, runtime: { uid: 0, gid: 0 } });
          await workers.seal();
        }
        throw failure;
      },
      verifySnapshot: forbidden, rotate: forbidden, selectSource: forbidden,
      dependencies: forbidden, build: forbidden, configure: forbidden,
      start: async context => {
        assert.equal(context.activationPurpose, 'prior-runtime');
        active = await stopped.activate({ purpose: context.activationPurpose });
      },
      verify: async context => {
        assert.equal(context.activationPurpose, 'prior-runtime');
        const inspection = await inspectLinuxService(f);
        try {
          assert.equal(inspection.identity.runtime.invocationId, active.identity.runtime.invocationId);
          await inspection.check();
        } finally { await inspection.close(); }
        if (recoveryMode === 'verify-failure') throw healthFailure;
      },
    }), error => recoveryMode === 'verify-failure'
      ? error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === healthFailure
      : error === failure);
    if (recoveryMode === 'verify-failure') {
      assert.equal((await loadState(control)).phase, 'recovery-required');
      await assert.rejects(stopped.retire(), error => error.recoveryAllowed === false);
      await assert.rejects(releaseLock(control, lock), /service/i);
      assert.equal((await reconcileInterruptedOperation(control)).status, 'blocked');
      assert.ok((await fs.readdir(control)).includes('service-activation.ndjson'));
      return;
    }
    assert.equal((await loadState(control)).phase, 'prior-runtime-restored');
    assert.equal((await loadState(control)).errorCode, 'BACKUP_FAILED');
    await stopped.retire();
    await workers?.retire();
    await releaseLock(control, lock);
    assert.deepEqual(await fs.readdir(control), ['state.json']);
    assert.equal((await reconcileInterruptedOperation(control)).status, 'prior-runtime-restored');
    assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
    const next = await acquireLock(control, { project: f.project, operationId: randomUUID() });
    await releaseLock(control, next);
  } finally { await workers?.close(); await stopped?.close(); }
});
}
