import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';

const execute = promisify(execFile);
const native = (file, args) => execute(file, args, { timeout: 20000, maxBuffer: 8192 });
const systemctl = (...args) => native('/usr/bin/systemctl', ['--system', ...args]);
const node = process.execPath;
const npm = path.join(path.dirname(node), 'npm');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

async function fixture(t, { command = `${quote(npm)} start`, settings = '', dropIn = '', nonroot = false } = {}) {
  const root = await temporaryDeployment(t);
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
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached:true, stdio:'ignore' });
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
    await writeFile(fragment, `${bytes}\n[Service]\nKillMode=control-group\nRestart=no\nExecStop=\n`);
    await systemctl('daemon-reload');
    await systemctl('stop', unit);
    await unlink(fragment);
    if (dropIn) await rm(dropDirectory, { recursive: true });
    await systemctl('daemon-reload');
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
