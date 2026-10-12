import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { interruptWindowsColdApplication } from './deployment-windows-cold-application-recovery.mjs';
import { verifyWindowsApplicationApi } from './deployment-windows-application-api-helpers.mjs';

export async function verifyWindowsColdApplicationTerminal({ mode, directory, control, pwsh, chatId }) {
  const target = {
    'restore-cold-state-staged': 'state-staged',
    'restore-cold-state-published': 'state-published',
    'restore-cold-state-completed': 'complete',
  }[mode];
  assert.ok(target);
  const recovery = await import(pathToFileURL(
    path.join(directory, 'scripts/deployment/windows-cold-activation-recovery.mjs')));
  const journal = path.join(control, 'recovery-lock');
  const names = ['lock/owner.json', 'task-maintenance/transaction.json', 'deployment.json', 'backup/manifest.json',
    ...(await readdir(journal)).map(name => `recovery-lock/${name}`)];
  const before = await Promise.all(names.map(name => readFile(path.join(control, name))));
  const statePath = path.join(control, 'state.json');
  const markerPath = path.join(control, 'cold-restore-terminal.json');
  if (target === 'state-staged') {
    await assert.rejects(lstat(markerPath), { code: 'ENOENT' });
    const old = await readFile(statePath);
    const prepared = await recovery.prepareWindowsColdTerminalRestore({ control, pwsh, acceptDataLoss: true });
    assert.equal(prepared.record.oldState, old.toString('utf8'));
    assert.deepEqual(await readFile(statePath), old);
  }
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes);
  const unchanged = async () => {
    assert.deepEqual(await readFile(markerPath), markerBytes);
    assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(control, name)))), before);
    await verifyWindowsApplicationApi('restored', chatId);
  };
  process.stderr.write(`${new Date().toISOString()} Actual cold terminal state: ${target}\n`);
  await unchanged();
  const result = await recovery.publishWindowsColdTerminalState({
    control, pwsh, acceptDataLoss: true,
    onProgress: async progress => {
      if (progress.step !== target) return;
      assert.equal((await readFile(statePath)).toString('utf8'),
        target === 'state-staged' ? marker.oldState : marker.nextState);
      if (target === 'state-staged') {
        assert.equal((await readFile(`${statePath}.lock`)).toString('utf8'), marker.nextState);
      } else { await assert.rejects(lstat(`${statePath}.lock`), { code: 'ENOENT' }); }
      await unchanged();
      await interruptWindowsColdApplication({
        status: 'cold-terminal-state-interrupted', step: progress.step, operationId: marker.operationId,
        runtime: marker.runtime, lease: 'released',
      });
      assert.fail('Interrupted actual terminal state actor unexpectedly returned.');
    },
  });
  assert.equal(target, 'complete', 'Actual terminal interruption boundary was skipped.');
  assert.equal(result.status, 'cold-terminal-state-published');
  assert.equal((await readFile(statePath)).toString('utf8'), marker.nextState);
  assert.equal(JSON.parse(marker.nextState).phase, 'restored');
  const original = await lstat(statePath, { bigint: true });
  assert.deepEqual(await recovery.publishWindowsColdTerminalState({ control, pwsh, acceptDataLoss: true }), result);
  const current = await lstat(statePath, { bigint: true });
  assert.equal(current.dev, original.dev);
  assert.equal(current.ino, original.ino);
  assert.equal(current.mtimeNs, original.mtimeNs);
  assert.equal((await readFile(statePath)).toString('utf8'), marker.nextState);
  await assert.rejects(lstat(`${statePath}.lock`), { code: 'ENOENT' });
  await unchanged();
  return { ...result, status: 'cold-terminal-state-recovered', step: 'complete', runtime: marker.runtime, lease: 'released' };
}
