import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { restoreCandidate } from './deployment-linux-restore-fixture.mjs';
import { interrupted } from './deployment-linux-service-recovery-fixture.mjs';
import { releaseLock } from '../scripts/deployment/state.mjs';
import { admitLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-admission.mjs';

async function candidate(t, phase = 'stopped') {
  const f = await restoreCandidate(t);
  await releaseLock(f.control, f.lock);
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    path.join(f.project, 'scripts', 'deployment'), { recursive: true });
  return interrupted(t, phase, 'accepted', 'none', f);
}

test('cold restore admission rejects a live controller and binds dead-owner evidence without replacing its lock', async t => {
  const f = await candidate(t);
  const lockFile = path.join(f.control, 'lock', 'owner.json');
  const originalLock = await readFile(lockFile);
  const originalState = await readFile(path.join(f.control, 'state.json'));
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: false }), /acknowledg|data.loss/i);
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /alive|live|owner/i);
  await f.kill();
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  assert.equal(admitted.snapshot.id, 'live-restore');
  assert.deepEqual(admitted.lock, f.lock);
  assert.deepEqual(admitted.providers, ['credentials']);
  await admitted.check();
  assert.deepEqual(await readFile(lockFile), originalLock);
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), originalState);
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }), /admission|locking/i);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

test('cold restore admission refuses incomplete service evidence and unclassified workers without repairing either', async t => {
  const f = await candidate(t);
  await f.kill();
  const journal = path.join(f.control, 'service-stop.ndjson');
  const original = await readFile(journal);
  await writeFile(journal, original.subarray(0, original.length - 1));
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }));
  assert.deepEqual(await readFile(journal), original.subarray(0, original.length - 1));
  await writeFile(journal, original);
  const worker = path.join(f.control, 'worker-unclassified.ndjson');
  await writeFile(worker, '{"partial":', { mode: 0o600 });
  await assert.rejects(admitLinuxColdRestore({ ...f, acceptDataLoss: true }));
  assert.equal(await readFile(worker, 'utf8'), '{"partial":');
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

test('cold restore admission rechecks the selected complete backup before permitting later restoration', async t => {
  const f = await candidate(t);
  await f.kill();
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  await writeFile(path.join(f.backup, 'files', 'saved-data'), 'changed');
  await assert.rejects(admitted.check(), /checksum|integrity|changed/i);
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});

test('cold restore admission recognizes only the recorded stopped activation and its two inhibitor links', async t => {
  const f = await candidate(t, 'activation-stop:activation-stopped');
  await f.kill();
  const records = (await readFile(path.join(f.control, 'service-activation.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const admitted = await admitLinuxColdRestore({ ...f, acceptDataLoss: true });
  t.after(() => admitted.close());
  assert.deepEqual(admitted.service.identity, records.at(-1).started);
  await admitted.check();
  assert.equal(await readFile(path.join(f.project, 'saved-data'), 'utf8'), 'new data');
});
