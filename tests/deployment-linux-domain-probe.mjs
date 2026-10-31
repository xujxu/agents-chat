import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, readlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const unit = `agents-deploy-${randomUUID()}.service`;
const command = (file, args) => execute(file, args, { timeout: 30000, maxBuffer: 16384 });
const properties = async () => {
  const { stdout } = await command('systemctl', ['show', unit,
    '--property=InvocationID,ControlGroup,ActiveState,SubState,Result,MainPID']);
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
};
let handle;
let directory;
let creationAttempted = false;
const errors = [];
try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  assert.match(await readFile('/proc/1/comm', 'utf8'), /^systemd\n$/);
  await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
  creationAttempted = true;
  await command('systemd-run', ['--system', '--quiet', '--unit', unit,
    '--property=Type=exec', '--property=RemainAfterExit=yes',
    '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
    '--property=Restart=no', '--property=TimeoutStartSec=15s',
    '--property=TimeoutStopSec=10s', '--property=RuntimeMaxSec=60s',
    '/usr/bin/sleep', 'infinity']);
  const initial = await properties();
  assert.match(initial.InvocationID, /^[a-f0-9]{32}$/);
  assert.equal(initial.ControlGroup, `/system.slice/${unit}`);
  handle = await open(`/sys/fs/cgroup${initial.ControlGroup}/cgroup.events`, 'r');
  directory = await open(`/sys/fs/cgroup${initial.ControlGroup}`, 'r');
  const retained = async () => {
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString('utf8');
  };
  assert.match(await retained(), /^populated 1$/m);
  await command('systemctl', ['kill', '--kill-whom=all', '--signal=SIGKILL', unit]);
  const samples = [];
  for (let index = 0; index < 20; index++) {
    let events;
    try { events = await retained(); }
    catch (error) { events = { code: error.code }; }
    const state = await properties();
    const retainedDirectory = await readlink(`/proc/self/fd/${directory.fd}`);
    if (!samples.length || JSON.stringify(samples.at(-1)) !== JSON.stringify({ events, state, retainedDirectory })) {
      samples.push({ events, state, retainedDirectory });
    }
    await delay(100);
  }
  assert.ok(samples.some(sample => sample.events?.code === 'ENODEV'
    && sample.retainedDirectory === `/sys/fs/cgroup${initial.ControlGroup} (deleted)`));
  console.log(JSON.stringify({ unit, initial, samples }));
} catch (error) { errors.push(error); }
if (handle) {
  try { await handle.close(); }
  catch (error) { errors.push(error); }
}
if (directory) {
  try { await directory.close(); }
  catch (error) { errors.push(error); }
}
if (creationAttempted) {
  for (const args of [['stop', unit], ['reset-failed', unit]]) {
    try { await command('systemctl', args); }
    catch (error) { errors.push(error); }
  }
}
if (errors.length) throw new AggregateError(errors, 'Native Linux domain characterization failed.');
