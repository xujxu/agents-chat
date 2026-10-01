import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freshInstallationFixture } from './deployment-linux-first-fixture.mjs';
import { inspectLinuxFirstInstall } from '../scripts/deployment/linux-first-install.mjs';
import { acquireLock, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { linuxNative, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

async function fixture(t, { phase = 'configuring' } = {}) {
  const f = await freshInstallationFixture(t);
  const installation = await inspectLinuxFirstInstall(f);
  await mkdir(f.control, { mode: 0o700 });
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  let previousPhase = null;
  for (const current of ['preflight', 'source-selected', 'dependencies', 'building', 'configuring']) {
    await writeState(f.control, {
      version: 1, operationId: lock.operationId, project: f.project, operation: 'deploy', phase: current,
      previousPhase, sourceCommit: 'a'.repeat(40), targetCommit: 'a'.repeat(40), backupId: null,
      priorRuntime: 'absent', runtimeIdentity: 'first-unit-fixture', startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: null,
    });
    previousPhase = current;
    if (current === phase) break;
  }
  const saved = await saveWorkerEngine({ control: f.control, project: f.project, operationId: lock.operationId,
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)) });
  const operation = await createWorkerOperation({ control: f.control, lock, saved });
  await operation.seal();
  t.after(() => operation.close());
  const fragment = `/etc/systemd/system/${f.unit}`;
  const inhibition = `${fragment}.d/90-agents-chat-deployment.conf`;
  t.after(async () => {
    for (const file of [inhibition, fragment]) {
      try { await unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { await rmdir(path.dirname(inhibition)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
  });
  return { ...f, installation, lock, fragment, inhibition };
}

test('first unit publication retains genuine inactive configuration and refuses manual startup', async t => {
  const { createLinuxFirstUnit } = await import('../scripts/deployment/linux-first-unit.mjs');
  const f = await fixture(t);
  const created = await createLinuxFirstUnit(f);
  t.after(() => created.close());
  assert.equal(created.status, 'configured-inhibited');
  assert.equal(created.identity.configuration.state.WorkingDirectory, f.project);
  assert.equal(created.identity.configuration.state.User, '65534');
  assert.equal(created.identity.configuration.state.Group, '65534');
  assert.equal(created.identity.configuration.state.Slice, 'system.slice');
  assert.equal(created.identity.configuration.state.Delegate, 'no');
  assert.equal(created.identity.configuration.state.MainPID, '0');
  assert.equal(created.identity.configuration.state.ControlGroup, '');
  assert.equal(JSON.stringify(created).includes('first-install-private'), false);
  await created.check();
  await assert.rejects(linuxNative('/usr/bin/systemctl', ['--system', 'start', f.unit]));
  assert.equal((await linuxSystemdProperties(f.unit, ['MainPID'])).MainPID, '0');
  await created.check();
  await assert.rejects(readFile(path.join(f.control, 'deployment.json')), { code: 'ENOENT' });
  await assert.rejects(readdir(path.join(f.control, 'backup')), { code: 'ENOENT' });
  const records = (await readFile(path.join(f.control, 'service-install.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.phase), ['intent', 'reserved', 'inhibited', 'created', 'configured']);
  assert.equal(records[1].files[0].size, 0);
  await writeFile(f.fragment, `${await readFile(f.fragment, 'utf8')}\n# changed\n`);
  await assert.rejects(created.check(), /changed|replaced|identity/i);
});

test('first unit publication requires configuring phase before writing service evidence', async t => {
  const { createLinuxFirstUnit } = await import('../scripts/deployment/linux-first-unit.mjs');
  const f = await fixture(t, { phase: 'preflight' });
  const before = (await readdir(f.control)).sort();
  await assert.rejects(createLinuxFirstUnit(f), /configuring/i);
  assert.deepEqual((await readdir(f.control)).sort(), before);
  await assert.rejects(readFile(f.fragment), { code: 'ENOENT' });
});

test('first unit publication preserves a newly appeared foreign fragment', async t => {
  const { createLinuxFirstUnit } = await import('../scripts/deployment/linux-first-unit.mjs');
  const f = await fixture(t);
  await writeFile(f.fragment, '# foreign configuration\n', { flag: 'wx', mode: 0o600 });
  const before = (await readdir(f.control)).sort();
  await assert.rejects(createLinuxFirstUnit(f));
  assert.deepEqual((await readdir(f.control)).sort(), before);
  assert.equal(await readFile(f.fragment, 'utf8'), '# foreign configuration\n');
});
