import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsRestorePublication({ directory, control, snapshot, pwsh }) {
  const load = name => import(pathToFileURL(path.join(directory, name)));
  const { prepareWindowsRestoreRuntimeBundle } = await load('windows-runtime-publication.mjs');
  assert.equal(typeof prepareWindowsRestoreRuntimeBundle, 'function', 'Missing archived runtime bundle publication');
  const { inspectWindowsManagedTask } = await load('windows-managed-task.mjs');
  const { acquireLock, writeState, releaseLock } = await load('state.mjs');
  const { inspectWindowsSnapshotRuntime } = await load('windows-snapshot-runtime.mjs');
  const project = snapshot.project;
  const taskName = snapshot.runtime.task.name;
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  const stateFile = path.join(control, 'state.json');
  const originalStateBytes = await readFile(stateFile);
  const originalState = JSON.parse(originalStateBytes);
  const errors = [];
  let lock;
  let hidden = false;
  const originalConfiguration = snapshot.runtime.task.configuration;
  const hiddenConfiguration = `${originalConfiguration}.fixture-offline`;
  try {
    assert.notEqual(scope.observation.configuration, originalConfiguration);
    assert.notEqual(scope.observation.configurationSha256, snapshot.runtime.task.configurationSha256,
      'Restore publication must distinguish archived configuration from the current configuration.');
    lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
    const state = {
      ...originalState, operationId: lock.operationId, operation: 'restore',
      phase: 'restore-preflight', previousPhase: null, sourceCommit: originalState.targetCommit,
      targetCommit: snapshot.source.commit, backupId: snapshot.id,
      runtimeIdentity: scope.observation.runtime.generation, startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: null,
    };
    await writeState(control, state);
    const input = { scope, control, lock, node: process.execPath, pwsh,
      backup: path.join(control, 'backup'), snapshot };
    const destination = path.join(control, `runtime-${lock.operationId}`);
    for (const change of [
      { scope: { ...scope } }, { snapshot: { ...snapshot, id: 'foreign-backup' } },
      { lock: { ...lock, token: randomUUID() } }, { signal: AbortSignal.abort() },
    ]) await assert.rejects(prepareWindowsRestoreRuntimeBundle({ ...input, ...change }));
    for (const change of [
      { operation: 'update', phase: 'preflight' }, { targetCommit: 'f'.repeat(40) },
      { backupId: 'foreign-backup' }, { previousPhase: 'restoring' },
    ]) {
      // Inject invalid admission evidence without claiming a legal state transition.
      await writeFile(stateFile, `${JSON.stringify({ ...state, ...change })}\n`);
      await assert.rejects(prepareWindowsRestoreRuntimeBundle(input));
    }
    await writeFile(stateFile, `${JSON.stringify(state)}\n`);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    const archived = await inspectWindowsSnapshotRuntime({ ...input, project, taskName });
    await rename(originalConfiguration, hiddenConfiguration);
    hidden = true;
    const result = await prepareWindowsRestoreRuntimeBundle(input);
    assert.deepEqual(result, {
      directory: destination, configuration: path.join(destination, 'configuration.json'),
      sha256: snapshot.runtime.task.configurationSha256,
    });
    assert.notEqual(result.configuration, scope.observation.configuration);
    assert.deepEqual((await readdir(destination)).sort(), archived.files.map(file => file.name).sort());
    for (const file of archived.files) {
      assert.deepEqual(await readFile(path.join(destination, file.name)), await readFile(file.file));
    }
    await assert.rejects(prepareWindowsRestoreRuntimeBundle(input));
    await archived.check();
    assert.deepEqual(await scope.check(), scope.observation);
    assert.deepEqual(JSON.parse(await readFile(path.join(control, 'state.json'))), state);
    console.log('PASS: saved restore publisher uses only archived inputs with the historical configuration absent, preserves native policy and refuses foreign authority or overwrite');
  } catch (error) { errors.push(error); }
  if (hidden) {
    try { await rename(hiddenConfiguration, originalConfiguration); } catch (error) { errors.push(error); }
  }
  if (lock) {
    try { await writeFile(stateFile, originalStateBytes); } catch (error) { errors.push(error); }
    try { await releaseLock(control, lock, { pwsh }); } catch (error) { errors.push(error); }
  }
  try { await scope.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Archived runtime publication fixture or cleanup failed.');
}
