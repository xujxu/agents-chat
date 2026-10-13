import assert from 'node:assert/strict';
import { lstat, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { retireWindowsColdRestoredDeployment } from '../scripts/deployment/windows-cold-deployment-retirement.mjs';
import { closeCompletedWindowsDeployment } from '../scripts/deployment/windows-completed-closeout.mjs';
import { writeWorkerFile } from '../scripts/deployment/worker-files.mjs';

const [control, pwsh, target] = process.argv.slice(2);
assert.ok(['prepared', 'refusals', 'early', 'unlock', 'complete'].includes(target));
const preserved = new Map(await Promise.all(['state.json', 'deployment.json', 'backup/manifest.json'].map(async name => {
  const file = path.join(control, name);
  const info = await lstat(file, { bigint: true });
  return [name, { bytes: await readFile(file), info }];
})));
const state = JSON.parse(preserved.get('state.json').bytes);
const options = { control, pwsh, acceptDataLoss: true };
if (target === 'refusals') {
  const marker = path.join(control, 'worker-retirement.json');
  const bytes = await readFile(marker);
  const record = JSON.parse(bytes);
  const unchanged = async () => {
    assert.deepEqual(await readFile(marker), bytes);
    for (const entry of record.entries) {
      const info = await lstat(path.join(control, entry.path), { bigint: true });
      assert.equal(String(info.dev), entry.dev);
      assert.equal(String(info.ino), entry.ino);
    }
  };
  for (const name of ['worker-foreign.ndjson', 'worker-retirement.json.pending-foreign']) {
    const file = path.join(control, name);
    await writeWorkerFile(file, Buffer.from('foreign\n'));
    try { await assert.rejects(retireWindowsColdRestoredDeployment(options), { code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED' }); }
    finally { await rm(file); }
    await unchanged();
  }
  const file = path.join(control, record.entries[1].path);
  const held = path.join(control, '.cold-retirement-fixture-held');
  await rename(file, held);
  try { await assert.rejects(retireWindowsColdRestoredDeployment(options), { code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED' }); }
  finally { await rename(held, file); }
  await unchanged();
  await rename(file, held);
  try {
    await writeWorkerFile(file, await readFile(held));
    await assert.rejects(retireWindowsColdRestoredDeployment(options), { code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED' });
  } finally {
    await rm(file);
    await rename(held, file);
  }
  await unchanged();
  process.stdout.write(`${JSON.stringify({ result: 'refusals-preserved-original-evidence' })}\n`);
} else if (target === 'complete') {
  const result = await closeCompletedWindowsDeployment({
    control, project: state.project, operationId: state.operationId, pwsh,
  });
  assert.deepEqual(result, { status: 'completed', operationId: state.operationId, phase: 'restored' });
  const names = await readdir(control);
  for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
    'cold-restore-terminal.json', 'lock', 'worker-retirement.json']) assert.equal(names.includes(name), false, name);
  for (const [name, before] of preserved) {
    const file = path.join(control, name);
    assert.deepEqual(await readFile(file), before.bytes);
    const after = await lstat(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
  }
  process.stdout.write(`${JSON.stringify({ result })}\n`);
} else {
  await retireWindowsColdRestoredDeployment({
    ...options,
    onProgress: async progress => {
      assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.runtime));
      assert.equal(progress.operationId, state.operationId);
      assert.ok(progress.retiredEntries <= progress.totalEntries);
      const pause = target === 'prepared' ? progress.step === 'retirement-prepared' && progress.retiredEntries === 0
        : target === 'early' ? progress.step === 'entry-retired' && progress.retiredEntries === 2
          : progress.step === 'entry-retired' && progress.retiredEntries === progress.totalEntries - 2;
      if (!pause) return;
      await assert.rejects(readFile(path.join(control, 'worker-retirement.json')), { code: 'EBUSY' });
      process.stdout.write(`${JSON.stringify({ progress })}\n`);
      await new Promise(() => {});
    },
  });
  assert.fail('Cold retirement skipped its interruption boundary.');
}
