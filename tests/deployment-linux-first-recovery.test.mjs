import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { chown, cp, readFile, readdir, readlink, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { freshInstallationFixture } from './deployment-linux-first-fixture.mjs';
import { captureLockOwner } from '../scripts/deployment/state.mjs';
import { linuxNative, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';
import { retirementRecoveryInvocation } from '../scripts/deployment/saved-recovery-engine.mjs';

const execute = promisify(execFile);

async function interruptedFirst(t, phase) {
  let f;
  let child;
  let exited;
  let owner;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (!f) return;
    if (!owner) {
      try { owner = captureLockOwner(JSON.parse(await readFile(path.join(f.control, 'lock', 'owner.json'), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const fragment = `/etc/systemd/system/${f.unit}`;
    const inhibition = `${fragment}.d/90-agents-chat-deployment.conf`;
    const current = await linuxSystemdProperties(f.unit, ['LoadState', 'FragmentPath'], { allowMissing: true });
    if (current.LoadState !== 'not-found') {
      if (current.FragmentPath !== fragment) throw new Error('Unexpected first recovery fixture service source.');
      await linuxNative('/usr/bin/systemctl', ['--system', 'stop', f.unit]);
    }
    const files = [`/etc/systemd/system/multi-user.target.wants/${f.unit}`, inhibition, fragment];
    if (owner) files.push(`${inhibition}.${owner.token}.held`);
    for (const file of files) {
      try { await unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await rmdir(path.dirname(inhibition)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
  });
  f = await freshInstallationFixture(t);
  const server = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "const server = createServer((req, res) => {",
    "  const base = `http://127.0.0.1:${server.address().port}`;",
    "  res.writeHead(200, { 'Content-Type': 'application/json' });",
    "  res.end(JSON.stringify({ 'admin-login': { id: 'admin-login', name: 'fixture', type: 'credentials',",
    "    signinUrl: `${base}/signin`, callbackUrl: `${base}/callback` } }));",
    "});",
    "server.listen(0, '127.0.0.1', () => writeFileSync('fixture-port', String(server.address().port), { mode: 0o600 }));",
  ].join('\n');
  for (const [name, bytes] of [['server.mjs', server],
    ['package.json', JSON.stringify({ name: 'first-retirement-fixture', version: '1.0.0', scripts: { start: 'node server.mjs' } })]]) {
    const file = path.join(f.project, name);
    await writeFile(file, bytes);
    await chown(file, 65534, 65534);
  }
  const source = path.join(f.root, 'first-source');
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), source, { recursive: true });
  child = fork(new URL('./deployment-first-retirement-child.mjs', import.meta.url),
    [f.project, f.control, f.unit, source, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
  exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`First retirement did not pause: ${diagnostic}`)), 60000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`First retirement exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  owner = message.lock;
  const recover = async () => {
    const invocation = retirementRecoveryInvocation(message.saved, {
      control: f.control, project: f.project, operationId: owner.operationId, kind: 'service',
    });
    return execute(invocation.file, invocation.args, { env: invocation.env, timeout: 90000, maxBuffer: 8192 });
  };
  return { ...f, source, ...message, recover,
    startupLink: `/etc/systemd/system/multi-user.target.wants/${f.unit}`,
    kill: async () => { child.kill('SIGKILL'); await exited; } };
}

for (const phase of ['service-intent', 'service-unlink-1', 'worker-intent', 'live-lock-owner']) {
  test(`saved first-install recovery preserves enabled runtime after ${phase}`, async t => {
    const f = await interruptedFirst(t, phase);
    await assert.rejects(f.recover());
    await f.kill();
    const state = await readFile(path.join(f.control, 'state.json'));
    const deployment = await readFile(path.join(f.control, 'deployment.json'));
    const file = phase.startsWith('service-') ? 'service-retirement.json' : 'live-retirement.json';
    const marker = JSON.parse(await readFile(path.join(f.control, file), 'utf8'));
    assert.equal(marker.version, 4);
    assert.equal(marker.files.length, 4);
    assert.equal(marker.startup.startupLink, f.startupLink);
    await rename(f.source, `${f.source}.displaced`);
    assert.deepEqual(JSON.parse((await f.recover()).stdout), {
      status: 'service-retired', operationId: f.lock.operationId, restored: false,
    });
    await f.recover();
    assert.deepEqual((await readdir(f.control)).sort(),
      ['deployment.json', 'recovery-complete.json', 'recovery-engine', 'state.json']);
    assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
    assert.deepEqual(await readFile(path.join(f.control, 'deployment.json')), deployment);
    assert.equal(await readlink(f.startupLink), marker.startup.target);
    const observed = await linuxSystemdProperties(f.unit, ['InvocationID', 'UnitFileState']);
    assert.equal(observed.InvocationID, marker.runtime.runtime.invocationId);
    assert.equal(observed.UnitFileState, 'enabled');
  });
}

for (const phase of ['service-intent', 'live-lock-owner', 'completion']) {
  for (const change of ['startup-link', 'deployment-receipt']) {
    test(`first-install recovery refuses changed ${change} at ${phase}`, async t => {
      const f = await interruptedFirst(t, phase === 'completion' ? 'live-lock-owner' : phase);
      await f.kill();
      if (phase === 'completion') await f.recover();
      const target = await readlink(f.startupLink);
      if (change === 'startup-link') {
        await unlink(f.startupLink);
        await symlink(target, f.startupLink);
      } else {
        const receipt = path.join(f.control, 'deployment.json');
        await writeFile(receipt, Buffer.concat([await readFile(receipt), Buffer.from('\n')]));
      }
      const before = (await readdir(f.control)).sort();
      await assert.rejects(f.recover());
      assert.deepEqual((await readdir(f.control)).sort(), before);
      assert.equal(await readlink(f.startupLink), target);
    });
  }
}
