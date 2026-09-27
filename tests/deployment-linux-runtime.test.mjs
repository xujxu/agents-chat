import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectLinuxRuntimeAccount } from '../scripts/deployment/linux-runtime.mjs';

const execute = promisify(execFile);
async function fixture(t, extra = [], code = 'setInterval(()=>{},1000)', workingDirectory) {
  const root = await temporaryDeployment(t);
  await chmod(root, 0o711);
  const project = path.join(root, 'app');
  await mkdir(project, { mode: 0o755 });
  await chown(project, 65534, 65534);
  const unit = `agents-runtime-test-${randomUUID()}.service`;
  t.after(async () => {
    const before = await execute('/usr/bin/systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (before.stdout.trim() === 'not-found') return;
    await execute('/usr/bin/systemctl', ['stop', unit], { timeout: 15000 });
    const { stdout } = await execute('/usr/bin/systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (stdout.trim() !== 'not-found') await execute('/usr/bin/systemctl', ['reset-failed', unit]);
  });
  try {
    await execute('/usr/bin/systemd-run', ['--system', '--quiet', '--unit', unit,
      '--property=Type=exec', '--property=RemainAfterExit=yes', '--property=Restart=no',
      '--property=RuntimeMaxSec=120s', '--property=TimeoutStopSec=5s',
      '--property=KillMode=control-group', '--property=SendSIGKILL=yes',
      `--property=WorkingDirectory=${workingDirectory ?? project}`, ...extra, '--',
      process.execPath, '-e', code], { timeout: 15000, maxBuffer: 8192 });
  } catch (error) {
    const { stdout } = await execute('/usr/bin/systemctl', ['show', unit, '--property=Result,ExecMainCode,ExecMainStatus']);
    throw new Error(`Runtime fixture did not start: ${stdout}`, { cause: error });
  }
  return { project, unit };
}

test('reads actual non-root systemd identity and canonical home without changing the service', async t => {
  const f = await fixture(t, ['--property=User=65534', '--property=Group=65534']);
  const before = await execute('/usr/bin/systemctl', ['show', f.unit, '--property=MainPID,InvocationID,ActiveState']);
  const result = await inspectLinuxRuntimeAccount(f);
  assert.equal(result.uid, 65534);
  assert.equal(result.gid, 65534);
  assert.equal(result.project, await realpath(f.project));
  assert.equal(result.user, 'nobody');
  assert.equal(result.home, '/nonexistent');
  assert.ok(result.mainPid > 0);
  assert.match(result.invocationId, /^[a-f0-9]{32}$/);
  const after = await execute('/usr/bin/systemctl', ['show', f.unit, '--property=MainPID,InvocationID,ActiveState']);
  assert.equal(after.stdout, before.stdout);
});

test('preserves implicit root service identity instead of substituting the interactive user', async t => {
  const f = await fixture(t);
  const result = await inspectLinuxRuntimeAccount(f);
  assert.equal(result.uid, 0);
  assert.equal(result.gid, 0);
  assert.equal(result.user, 'root');
  assert.equal(result.home, '/root');
});

test('resolves named systemd users with their primary group when Group is omitted', async t => {
  const f = await fixture(t, ['--property=User=nobody']);
  const result = await inspectLinuxRuntimeAccount(f);
  assert.equal(result.uid, 65534);
  assert.equal(result.gid, 65534);
});

test('resolves named systemd groups without guessing from project ownership', async t => {
  const f = await fixture(t, ['--property=User=root', '--property=Group=root']);
  const result = await inspectLinuxRuntimeAccount(f);
  assert.equal(result.uid, 0);
  assert.equal(result.gid, 0);
});

test('rejects foreign project ownership without stopping either service', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectLinuxRuntimeAccount({ ...f, project: path.dirname(f.project) }), /project|directory/i);
  const { stdout } = await execute('/usr/bin/systemctl', ['show', f.unit, '--property=ActiveState', '--value']);
  assert.equal(stdout.trim(), 'active');
});

test('rejects explicitly configured supplementary groups instead of dropping required permissions silently', async t => {
  const f = await fixture(t, ['--property=User=65534', '--property=Group=65534', '--property=SupplementaryGroups=0']);
  await assert.rejects(inspectLinuxRuntimeAccount(f), /group/i);
});

test('rejects dynamic account identity before any deployment work', async t => {
  const f = await fixture(t, ['--property=DynamicUser=yes'], undefined, '/');
  await assert.rejects(inspectLinuxRuntimeAccount(f), /dynamic/i);
});

test('rejects inherited NSS supplementary groups instead of silently narrowing the installed account', async t => {
  const f = await fixture(t, ['--property=User=runner']);
  await assert.rejects(inspectLinuxRuntimeAccount(f), /group/i);
});

test('rejects service root namespaces even when a process is running', async t => {
  const f = await fixture(t, ['--property=RootDirectory=/']);
  await assert.rejects(inspectLinuxRuntimeAccount(f), /root/i);
});

test('missing units and untrusted unit names are explicit preflight errors', async t => {
  const project = await temporaryDeployment(t);
  for (const unit of ['missing-runtime-test.service', '../other.service', '--system', 'x.service\nother.service']) {
    await assert.rejects(inspectLinuxRuntimeAccount({ unit, project }));
  }
});

test('running process account mismatch is refused even when systemd configuration looks valid', async t => {
  const f = await fixture(t, [], 'process.setgid(65534);process.setuid(65534);require("node:fs").writeFileSync("ready","yes");setInterval(()=>{},1000)');
  for (let index = 0; index < 200; index++) {
    try { await readFile(path.join(f.project, 'ready')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (index === 199) throw new Error('Mismatched runtime fixture did not start.');
    await delay(25);
  }
  await assert.rejects(inspectLinuxRuntimeAccount(f), /account|groups/i);
});
