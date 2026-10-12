import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export function interruptWindowsColdApplication(result) {
  return new Promise((_, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, error => {
      if (error) reject(error);
      else process.exit(91);
    });
  });
}

export async function verifyWindowsColdApplicationRecovery({ mode, directory, control, pwsh, chatId }) {
  const target = {
    'restore-cold-policy-crashed': 'permanent-policy-applied',
    'restore-cold-enable-crashed': 'enable-applied',
    'restore-cold-completed': 'complete',
  }[mode];
  assert.ok(target);
  const { prepareWindowsColdCompletionRecovery } = await import(
    pathToFileURL(path.join(directory, 'scripts/deployment/windows-cold-activation-recovery.mjs')));
  const journal = path.join(control, 'recovery-lock');
  const names = ['state.json', 'lock/owner.json', 'deployment.json',
    ...(await readdir(journal)).map(name => `recovery-lock/${name}`)];
  const before = await Promise.all(names.map(name => readFile(path.join(control, name))));
  process.stderr.write(`${new Date().toISOString()} Actual cold completion recovery: ${target}\n`);
  const recovery = await prepareWindowsColdCompletionRecovery({ control, pwsh, acceptDataLoss: true });
  let progress = recovery.observation;
  try {
    assert.equal(progress.step, {
      'permanent-policy-applied': 'release-requested', 'enable-applied': 'permanent-policy-applied', complete: 'enable-applied',
    }[target]);
    assert.equal(progress.status, 'cold-completion-recovery');
    assert.equal(progress.lease, 'released');
    assert.equal(progress.port, 3010);
    await verifyWindowsApplicationApi('restored', chatId);
    let steps = 0;
    while (progress.step !== target) {
      assert.ok(steps++ < 9, 'Actual completion recovery skipped its physical boundary.');
      progress = await recovery.advance();
    }
    assert.deepEqual(await recovery.check(), progress);
    assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(control, name)))), before);
    await verifyWindowsApplicationApi('restored', chatId);
    if (target !== 'complete') {
      const missing = target === 'permanent-policy-applied' ? 'policy-restored' : 'complete';
      await assert.rejects(lstat(path.join(journal, `completion-${missing}.json`)), { code: 'ENOENT' });
      await interruptWindowsColdApplication({ ...progress, status: 'cold-completion-interrupted' });
      assert.fail('Interrupted actual recovery actor unexpectedly returned.');
    }
    assert.deepEqual(await recovery.advance(), progress);
  } finally { await recovery.close(); }
  assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(control, name)))), before);
  return { ...progress, status: 'cold-runtime-recovered' };
}
