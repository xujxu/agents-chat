import assert from 'node:assert/strict';
import fs, { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporaryDeployment, acceptOperation } from './deployment-fixture.mjs';
import { acquireLock, loadState } from '../scripts/deployment/state.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { publishDeploymentReceipt } from '../scripts/deployment/deployment-receipt.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const source = path.join(root, 'source');
  const control = path.join(root, 'control');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  await writeFile(path.join(project, 'data'), 'retained');
  await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), source, { recursive: true });
  const engines = [await saveRecoveryEngine({ source, control })];
  const helper = path.join(source, 'linux-readiness.mjs');
  for (let index = 0; index < 2; index++) {
    await writeFile(helper, `${await readFile(helper, 'utf8')}\n// Generation ${index}.\n`);
    engines.push(await saveRecoveryEngine({ source, control, allowVersionChange: true }));
  }
  const current = engines[2];
  const backup = await createSnapshot({
    project, destination: path.join(control, 'backup'), id: 'retained', files: ['data'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' }, runtime: { state: 'stopped', platform: 'linux' },
    recoveryEngine: current.manifestSha256,
  });
  const lock = await acquireLock(control, { project, operationId: 'retention' });
  await acceptOperation(control, lock);
  const identity = { source: 'a'.repeat(40), build: 'b'.repeat(64), dependencies: 'c'.repeat(64),
    config: 'd'.repeat(64), service: 'e'.repeat(64) };
  await publishDeploymentReceipt({ control, lock, identity, checkAccepted: async () => identity });
  return { project, control, lock, current, engines, backup };
}

test('engine retirement bounds completed updates to the legacy and retained backup generations', async t => {
  const { retireRecoveryEngines } = await import('../scripts/deployment/recovery-engine-retention.mjs');
  const f = await fixture(t);
  const state = await loadState(f.control);
  await retireRecoveryEngines(f);
  assert.deepEqual((await readdir(f.control)).filter(name => name.startsWith('recovery-engine')).sort(),
    ['recovery-engine', path.basename(f.current.directory)]);
  assert.deepEqual(await verifySnapshot(path.join(f.control, 'backup')), f.backup);
  assert.deepEqual(await loadState(f.control), state);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.control, 'lock/owner.json'))), f.lock);
  await retireRecoveryEngines(f);
});

test('retiring engine resumes partial unlink without touching the retained backup engine', async t => {
  const { retireRecoveryEngines } = await import('../scripts/deployment/recovery-engine-retention.mjs');
  const f = await fixture(t);
  const retired = path.join(f.control, `retired-recovery-engine-${f.engines[1].manifestSha256}`);
  const original = fs.unlink;
  let interrupted = false;
  fs.unlink = async (...args) => {
    await original(...args);
    if (!interrupted && String(args[0]).startsWith(`${retired}${path.sep}`)) {
      interrupted = true;
      throw new Error('retirement interrupted after unlink');
    }
  };
  syncBuiltinESMExports();
  try { await assert.rejects(retireRecoveryEngines(f), /retirement interrupted/); }
  finally { fs.unlink = original; syncBuiltinESMExports(); }
  assert.equal(interrupted, true);
  await retireRecoveryEngines(f);
  await assert.rejects(readdir(retired), { code: 'ENOENT' });
  assert.deepEqual(await verifySnapshot(path.join(f.control, 'backup')), f.backup);
});

for (const kind of ['worker', 'staging', 'foreign-file', 'symlink', 'backup']) {
  test(`engine retirement refuses ${kind} evidence instead of deleting or hiding it`, async t => {
    const { retireRecoveryEngines } = await import('../scripts/deployment/recovery-engine-retention.mjs');
    const f = await fixture(t);
    if (kind === 'worker') await writeFile(path.join(f.control, 'worker-unknown.ndjson'), '', { mode: 0o600 });
    if (kind === 'staging') await mkdir(path.join(f.control, 'recovery-engine-incomplete.staging'), { mode: 0o700 });
    if (kind === 'foreign-file') await writeFile(path.join(f.engines[1].directory, 'unknown'), '', { mode: 0o600 });
    if (kind === 'symlink') await symlink('data', path.join(f.engines[1].directory, 'linked.mjs'));
    if (kind === 'backup') await writeFile(path.join(f.control, 'backup/files/data'), 'changed');
    const before = (await readdir(f.control)).sort();
    await assert.rejects(retireRecoveryEngines(f));
    assert.deepEqual((await readdir(f.control)).sort(), before);
  });
}
