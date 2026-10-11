import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsInterruptedRestore({ scenario, project, control, backup, snapshot, recovery, taskName, pwsh }) {
  assert.ok(['cancelled', 'failed'].includes(scenario));
  const saved = name => import(pathToFileURL(path.join(recovery.directory, name)));
  const { runWindowsLiveRestore } = await saved('windows-restore.mjs');
  const { inspectWindowsManagedTask } = await saved('windows-managed-task.mjs');
  const { acquireLock, assertLockOwner, loadState } = await saved('state.mjs');
  const { verifySnapshot } = await saved('snapshot.mjs');
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  const errors = [];
  let result;
  try {
    const files = ['deployment-live-target.txt', '.git/HEAD', '.next/BUILD_ID', '.env.local'];
    const before = await Promise.all(files.map(name => readFile(path.join(project, name))));
    assert.equal(before.at(-1).toString(), 'DEPLOYMENT_RESTORE_FIXTURE=after-update\n');
    const receipt = await readFile(path.join(control, 'deployment.json'));
    const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    const cancellation = new AbortController();
    const failure = new Error('Actual restore failure after project mutation');
    const errorCode = scenario === 'cancelled' ? 'DEPLOYMENT_STAGE_CANCELLED' : 'DEPLOYMENT_RESTORE_FAILED';
    let injected = false;
    await assert.rejects(runWindowsLiveRestore({
      scope, control, lock, backup, node: process.execPath, pwsh,
      profile: 'agents-chat-auth-638c553', port: 3010, acceptDataLoss: true,
      waitSeconds: 120, signal: cancellation.signal,
      onProgress({ phase, stage }) {
        process.stderr.write(`${new Date().toISOString()} Interrupted restore (${scenario}) phase: ${phase}${stage ? ` / ${stage}` : ''}\n`);
        if (scenario === 'cancelled' && stage === 'project-files') {
          injected = true;
          cancellation.abort();
        }
        if (scenario === 'failed' && stage === 'external-files') {
          injected = true;
          throw failure;
        }
      },
    }), scenario === 'cancelled'
      ? { code: 'DEPLOYMENT_STAGE_CANCELLED', stage: 'restoreFiles', recoveryAllowed: true }
      : error => error === failure);
    assert.ok(injected, 'Actual stopped restore never reached interruption injection.');
    assert.equal(cancellation.signal.aborted, scenario === 'cancelled');
    const state = await loadState(control);
    assert.equal(state.operation, 'restore');
    assert.equal(state.phase, 'recovery-required');
    assert.equal(state.previousPhase, 'restoring');
    assert.equal(state.errorCode, errorCode);
    assert.equal(state.operationId, lock.operationId);
    assert.equal(state.backupId, snapshot.id);
    assert.equal(state.targetCommit, snapshot.source.commit);
    await assertLockOwner(control, lock);
    if (scenario === 'cancelled') {
      assert.deepEqual(await Promise.all(files.map(name => readFile(path.join(project, name)))), before);
    } else {
      await assert.rejects(lstat(path.join(project, 'deployment-live-target.txt')), { code: 'ENOENT' });
      for (const name of ['.env.local', '.next/BUILD_ID', 'package-lock.json',
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
        assert.deepEqual(await readFile(path.join(project, name)), await readFile(path.join(backup, 'files', name)));
      }
    }
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    result = { status: scenario, operationId: lock.operationId, runtime: scope.observation.runtime };
  } catch (error) { errors.push(error); }
  try { await scope.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Actual interrupted Windows restore or scope cleanup failed.');
  return result;
}
