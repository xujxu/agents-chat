import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interruptWindowsColdApplication } from './deployment-windows-cold-application-recovery.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdApplicationRetirement({ mode, directory, control, pwsh, chatId }) {
  const target = {
    'restore-cold-retirement-prepared': 'prepared',
    'restore-cold-retirement-early': 'early',
    'restore-cold-retirement-unlock': 'unlock',
    'restore-cold-retirement-completed': 'complete',
  }[mode];
  assert.ok(target);
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { retireWindowsColdRestoredDeployment } = await captured('windows-cold-deployment-retirement.mjs');
  const { verifyRecoveryEngine } = await captured('saved-recovery-engine.mjs');
  const preserved = new Map(await Promise.all(['state.json', 'deployment.json', 'backup/manifest.json'].map(async name => {
    const file = path.join(control, name);
    return [name, { bytes: await readFile(file), info: await lstat(file, { bigint: true }) }];
  })));
  const state = JSON.parse(preserved.get('state.json').bytes);
  const backup = JSON.parse(preserved.get('backup/manifest.json').bytes);
  const record = JSON.parse(await readFile(path.join(control, target === 'prepared'
    ? 'cold-restore-terminal.json' : 'worker-retirement.json')));
  const runtime = target === 'prepared' ? record.runtime : record.completion.runtime;
  const unchanged = async () => {
    for (const [name, before] of preserved) {
      const file = path.join(control, name);
      assert.deepEqual(await readFile(file), before.bytes);
      const after = await lstat(file, { bigint: true });
      for (const key of ['dev', 'ino', 'mtimeNs']) assert.equal(after[key], before.info[key], `${name}: ${key}`);
    }
    await verifyWindowsApplicationApi('restored', chatId);
  };
  await unchanged();
  process.stderr.write(`${new Date().toISOString()} Actual cold retirement: ${target}\n`);
  if (target !== 'complete') {
    await retireWindowsColdRestoredDeployment({
      control, pwsh, acceptDataLoss: true,
      onProgress: async progress => {
        assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.runtime));
        assert.equal(progress.operationId, state.operationId);
        assert.deepEqual(progress.runtime, runtime);
        assert.equal(progress.lease, 'released');
        const pause = target === 'prepared' ? progress.step === 'retirement-prepared' && progress.retiredEntries === 0
          : target === 'early' ? progress.step === 'entry-retired' && progress.retiredEntries === 2
            : progress.step === 'entry-retired' && progress.retiredEntries === progress.totalEntries - 2;
        if (!pause) return;
        await unchanged();
        await assert.rejects(readFile(path.join(control, 'worker-retirement.json')), { code: 'EBUSY' });
        await lstat(path.join(control, 'lock/owner.json'));
        if (target !== 'prepared') {
          await assert.rejects(lstat(path.join(control, 'task-maintenance/admission.json')), { code: 'ENOENT' });
          await assert.rejects(lstat(path.join(control, 'task-maintenance/transaction.json')), { code: 'ENOENT' });
        }
        if (target === 'unlock') {
          for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
            'cold-restore-terminal.json']) await assert.rejects(lstat(path.join(control, name)), { code: 'ENOENT' });
        }
        await interruptWindowsColdApplication({ ...progress, status: 'cold-retirement-interrupted', boundary: target });
        assert.fail('Interrupted actual retirement actor unexpectedly returned.');
      },
    });
    assert.fail('Actual retirement skipped its requested boundary.');
  }
  const saved = await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine });
  const { closeCompletedWindowsDeployment } = await import(pathToFileURL(path.join(saved.directory, 'windows-completed-closeout.mjs')));
  const result = await closeCompletedWindowsDeployment({
    control, project: state.project, operationId: state.operationId, pwsh,
  });
  assert.deepEqual(result, { status: 'completed', operationId: state.operationId, phase: 'restored' });
  const names = await readdir(control);
  for (const name of ['task-maintenance', 'recovery-lock', 'worker-engine', 'worker-operation.ndjson',
    'cold-restore-terminal.json', 'lock', 'worker-retirement.json']) assert.equal(names.includes(name), false, name);
  await unchanged();
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: backup.recoveryEngine }), saved);
  return { ...result, status: 'cold-retirement-completed', boundary: 'complete', runtime, lease: 'released' };
}
