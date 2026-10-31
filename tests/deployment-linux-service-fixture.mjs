import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const execute = promisify(execFile);
const native = (file, args) => execute(file, args, { timeout: 20000, maxBuffer: 8192 });
export const systemctl = (...args) => native('/usr/bin/systemctl', ['--system', ...args]);
export const node = process.execPath;
export const npm = path.join(path.dirname(node), 'npm');
export const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export async function fixture(t, { command = `${quote(npm)} start`, settings = '', dropIn = '', nonroot = false, server, unitName, start = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), 'agents-deployment-test-')));
  const project = path.join(root, 'app with spaces');
  await mkdir(project);
  if (nonroot) {
    await chmod(root, 0o711);
    await chmod(project, 0o755);
    await chown(project, 65534, 65534);
  }
  const unit = unitName ?? `agents-service-test-${randomUUID()}.service`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.service$/.test(unit)) throw new Error('Invalid fixture unit name.');
  const fragment = `/etc/systemd/system/${unit}`;
  const dropDirectory = `${fragment}.d`;
  const dropFile = path.join(dropDirectory, '10-test.conf');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    private: true, scripts: { start: `${JSON.stringify(node)} server.cjs` },
  }));
  await writeFile(path.join(project, 'server.cjs'), server ?? `
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
${typeof settings === 'function' ? settings({ project }) : settings}
`;
  await writeFile(fragment, bytes, { flag: 'wx', mode: 0o644 });
  t.after(async () => {
    const state = (await systemctl('show', unit, '--property=ActiveState,SubState,Result')).stdout;
    if (/^Result=(?!success$).+/m.test(state)) {
      const { stdout } = await native('/usr/bin/journalctl', ['-b', '--no-pager', '-n', '12', '-u', unit]);
      t.diagnostic(`Fixture service failure before cleanup:\n${state}${stdout}`);
    }
    await rm(dropDirectory, { recursive: true, force: true });
    await writeFile(fragment, `${bytes}\n[Unit]\nRefuseManualStop=no\n[Service]\nKillMode=control-group\nRestart=no\nExecStop=\n`);
    await systemctl('daemon-reload');
    await systemctl('stop', unit);
    await unlink(fragment);
    await systemctl('daemon-reload');
    await rm(root, { recursive: true });
  });
  if (dropIn) {
    await mkdir(dropDirectory, { mode: 0o755 });
    await writeFile(dropFile, `[Service]\n${dropIn}\n`, { mode: 0o644 });
  }
  await systemctl('daemon-reload');
  if (start) {
    try { await systemctl('start', unit); }
    catch (error) {
      const { stdout } = await native('/usr/bin/journalctl', ['-b', '--no-pager', '-n', '8', `--grep=${unit}`]);
      throw new Error(`Installed service fixture could not start: ${stdout}`, { cause: error });
    }
  }
  return { unit, project, npm, node, fragment, dropFile, bytes };
}

export async function ready(f) {
  for (let index = 0; index < 400; index++) {
    try { return Number(await readFile(path.join(f.project, 'ready'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error('npm service fixture did not become ready.');
}

export async function quiescentFixture(t, state, { settings = '' } = {}) {
  if (!['inactive', 'failed'].includes(state)) throw new Error('Unsupported quiescent service fixture state.');
  const f = await fixture(t, { nonroot: true, start: false,
    settings: [state === 'failed' ? 'Restart=no' : '', settings].filter(Boolean).join('\n'),
    ...(state === 'failed' ? { server: 'process.exit(42);' } : {}) });
  if (state === 'failed') {
    try { await systemctl('start', f.unit); }
    catch (error) { assert.equal(error.code, 1); }
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState === 'failed') break;
      await delay(100);
    }
    assert.equal((await linuxSystemdProperties(f.unit, ['ExecMainStatus'])).ExecMainStatus, '42');
  }
  assert.equal((await linuxSystemdProperties(f.unit, ['ActiveState'])).ActiveState, state);
  return f;
}
