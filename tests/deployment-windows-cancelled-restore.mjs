import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsCancelledRestore({ project, control, backup, snapshot, recovery, taskName, pwsh }) {
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
    let injected = false;
    await assert.rejects(runWindowsLiveRestore({
      scope, control, lock, backup, node: process.execPath, pwsh,
      profile: 'agents-chat-auth-638c553', port: 3010, acceptDataLoss: true,
      waitSeconds: 120, signal: cancellation.signal,
      onProgress({ phase, stage }) {
        process.stderr.write(`${new Date().toISOString()} Cancelled restore phase: ${phase}${stage ? ` / ${stage}` : ''}\n`);
        if (stage === 'project-files') {
          injected = true;
          cancellation.abort();
        }
      },
    }), { code: 'DEPLOYMENT_STAGE_CANCELLED', stage: 'restoreFiles', recoveryAllowed: true });
    assert.ok(injected, 'Actual stopped restore never reached cancellation injection.');
    const state = await loadState(control);
    assert.equal(state.operation, 'restore');
    assert.equal(state.phase, 'recovery-required');
    assert.equal(state.previousPhase, 'restoring');
    assert.equal(state.errorCode, 'DEPLOYMENT_STAGE_CANCELLED');
    assert.equal(state.operationId, lock.operationId);
    assert.equal(state.backupId, snapshot.id);
    assert.equal(state.targetCommit, snapshot.source.commit);
    await assertLockOwner(control, lock);
    assert.deepEqual(await Promise.all(files.map(name => readFile(path.join(project, name)))), before);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    result = { status: 'cancelled', operationId: lock.operationId, runtime: scope.observation.runtime };
  } catch (error) { errors.push(error); }
  try { await scope.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Actual cancelled Windows restore or scope cleanup failed.');
  return result;
}
