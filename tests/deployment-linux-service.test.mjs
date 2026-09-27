import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { chmod, chown, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { stopLinuxService } from '../scripts/deployment/linux-service-stop.mjs';
import { acquireLock, writeState, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';

const execute = promisify(execFile);
const native = (file, args) => execute(file, args, { timeout: 20000, maxBuffer: 8192 });
const systemctl = (...args) => native('/usr/bin/systemctl', ['--system', ...args]);
const node = process.execPath;
const npm = path.join(path.dirname(node), 'npm');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

async function fixture(t, { command = `${quote(npm)} start`, settings = '', dropIn = '', nonroot = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), 'agents-deployment-test-')));
  const project = path.join(root, 'app with spaces');
  await mkdir(project);
  if (nonroot) {
    await chmod(root, 0o711);
    await chmod(project, 0o755);
    await chown(project, 65534, 65534);
  }
  const unit = `agents-service-test-${randomUUID()}.service`;
  const fragment = `/etc/systemd/system/${unit}`;
  const dropDirectory = `${fragment}.d`;
  const dropFile = path.join(dropDirectory, '10-test.conf');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    private: true, scripts: { start: `${JSON.stringify(node)} server.cjs` },
  }));
  await writeFile(path.join(project, 'server.cjs'), `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>require("node:fs").appendFileSync("writes","x"),20)'], { detached:true, stdio:'ignore' });
fs.writeFileSync('ready', String(child.pid));
setInterval(()=>{},1000);
`);
  const bytes = `[Unit]
Description=Isolated deployment service fixture
[Service]
Type=simple
User=${nonroot ? 'nobody' : 'root'}
Group=${nonroot ? 'nogroup' : 'root'}
WorkingDirectory=${project.replaceAll('%', '%%')}
Environment=PATH=${path.dirname(node)}:/usr/bin:/bin
ExecStart=${command}
Restart=on-failure
RestartSec=1s
KillMode=control-group
SendSIGKILL=yes
TimeoutStopSec=2s
${settings}
`;
  t.after(async () => {
    await rm(dropDirectory, { recursive: true, force: true });
    await writeFile(fragment, `${bytes}\n[Unit]\nRefuseManualStop=no\n[Service]\nKillMode=control-group\nRestart=no\nExecStop=\n`);
    await systemctl('daemon-reload');
    await systemctl('stop', unit);
    await unlink(fragment);
    await systemctl('daemon-reload');
    await rm(root, { recursive: true });
  });
  await writeFile(fragment, bytes, { flag: 'wx', mode: 0o644 });
  if (dropIn) {
    await mkdir(dropDirectory, { mode: 0o755 });
    await writeFile(dropFile, `[Service]\n${dropIn}\n`, { mode: 0o644 });
  }
  await systemctl('daemon-reload');
  try { await systemctl('start', unit); }
  catch (error) {
    const { stdout } = await native('/usr/bin/journalctl', ['-b', '--no-pager', '-n', '8', `--grep=${unit}`]);
    throw new Error(`Installed service fixture could not start: ${stdout}`, { cause: error });
  }
  return { unit, project, npm, node, fragment, dropFile, bytes };
}

async function ready(f) {
  for (let index = 0; index < 400; index++) {
    try { return Number(await readFile(path.join(f.project, 'ready'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error('npm service fixture did not become ready.');
}

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
  assert.equal((await systemctl('is-active', f.unit)).stdout.trim(), 'active');
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
  for (const settings of ['KillMode=process', 'Delegate=yes', 'ExecStop=/usr/bin/true']) {
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
  }
});
