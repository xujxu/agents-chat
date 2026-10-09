import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectWindowsManagedTask } from '../scripts/deployment/windows-managed-task.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';
import { readWorkerFile } from '../scripts/deployment/worker-files.mjs';
import { acquireLock, loadState, writeState, releaseLock } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation, readWorkerOperation } from '../scripts/deployment/worker-operation.mjs';
import { admitWindowsCompatibility } from '../scripts/deployment/windows-compatibility.mjs';

const [project, taskName, pwsh, git, control] = process.argv.slice(2);
const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
let operation;
let admission;
let failure;
try {
  const observed = scope.observation;
  assert.equal(observed.enabled, true);
  const bytes = await readWorkerFile(observed.configuration, 1024 * 1024, { privateMode: true });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), observed.configurationSha256);
  const configuration = JSON.parse(bytes);
  assert.equal(await realpath(configuration.command.file), await realpath(process.execPath));
  const { stdout } = await promisify(execFile)(git, ['-C', project, 'rev-parse', 'HEAD'], {
    timeout: 30000, maxBuffer: 1024,
  });
  const commit = stdout.trim();
  const options = { project, commit, nodeVersion: process.versions.node, platform: process.platform, git };
  const target = await inspectTargetCompatibility(options);
  assert.equal(target.status, 'target-supported');
  assert.equal(target.commit, commit);
  assert.equal(target.mode, 'declared');
  assert.equal(target.configurationProfile, 'agents-chat-auth-638c553');
  assert.equal(target.databaseProfile, 'agents-chat-638c553');
  await assert.rejects(inspectTargetCompatibility({
    ...options, git: path.join(path.dirname(git), `${randomUUID()}-missing-git.exe`),
  }), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED', check: 'target-inspection-unavailable' });
  await scope.check();
  console.log('PASS: actual managed Windows application target preflight uses explicit Git with minimal PATH and preserves its running task');
  const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
  const state = {
    version: 1, operationId: lock.operationId, project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: commit, targetCommit: commit,
    backupId: null, priorRuntime: 'running', runtimeIdentity: observed.runtime.generation,
    startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: null,
  };
  await writeState(control, state);
  const saved = await saveWorkerEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), control, project, operationId: lock.operationId,
  });
  operation = await createWorkerOperation({ control, lock, saved });
  const admissionOptions = { scope, control, lock, operation, node: process.execPath, git, pwsh, commit };
  for (const change of [{ scope: { ...scope } }, { lock: { ...lock, token: randomUUID() } }]) {
    await assert.rejects(admitWindowsCompatibility({ ...admissionOptions, ...change }));
  }
  assert.equal((await readWorkerOperation(control)).length, 1);
  admission = await admitWindowsCompatibility(admissionOptions);
  assert.equal(admission.compatibility, 'passed');
  assert.equal(admission.commit, commit);
  assert.deepEqual(admission.runtime, {
    status: 'runtime-observed', platform: 'win32', nodeVersion: process.versions.node,
  });
  assert.deepEqual(admission.configuration.providers, ['admin-login']);
  assert.equal(admission.data.profile, 'agents-chat-638c553');
  assert.deepEqual(admission.data.databases.find(database => database.name === 'chats.db'), {
    name: 'chats.db', status: 'data-supported',
  });
  await admission.check();
  await scope.check();
  const records = await readWorkerOperation(control);
  assert.equal(records.filter(record => record.phase === 'enrolled').length, 3);
  console.log('PASS: original Windows task runtime, configuration and live database admission use three settled native workers without downtime');
  const { closeRejectedWindowsPreflight } = await import('../scripts/deployment/windows-preflight-refusal.mjs');
  const closeOptions = { control, lock, scope, operation, pwsh };
  await assert.rejects(closeRejectedWindowsPreflight({ ...closeOptions, scope: { ...scope } }));
  assert.deepEqual(await loadState(control), state);
  assert.notEqual((await readWorkerOperation(control)).at(-1).phase, 'sealed');
  await assert.rejects(closeRejectedWindowsPreflight({
    ...closeOptions, lock: { ...lock, token: randomUUID() },
  }));
  const aborted = new AbortController();
  aborted.abort(new Error('Cancelled before preflight closeout'));
  await assert.rejects(closeRejectedWindowsPreflight({ ...closeOptions, signal: aborted.signal }));
  for (const changed of [
    { runtimeIdentity: randomUUID() }, { phase: 'stopped', previousPhase: 'preflight' },
    { startedAt: new Date(Date.parse(state.startedAt) + 1000).toISOString() },
  ]) {
    const stateFile = path.join(control, 'state.json');
    const original = await readWorkerFile(stateFile, 65536, { privateMode: true });
    try {
      await writeFile(stateFile, JSON.stringify({ ...state, ...changed }));
      await assert.rejects(closeRejectedWindowsPreflight(closeOptions));
      assert.notEqual((await readWorkerOperation(control)).at(-1).phase, 'sealed');
    } finally { await writeFile(stateFile, original); }
  }
  await admission.configuration.close();
  admission = undefined;
  const closed = await closeRejectedWindowsPreflight(closeOptions);
  assert.deepEqual(closed, { status: 'preflight-refused', operationId: lock.operationId });
  assert.equal((await loadState(control)).phase, 'preflight-refused');
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  assert.ok((await readdir(control)).every(name => !name.startsWith('worker-') && name !== 'task-maintenance'));
  await scope.check();
  const nextLock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
  await releaseLock(control, nextLock, { pwsh });
  await scope.check();
  console.log('PASS: rejected Windows preflight retires settled workers and unlocks without stopping the original application');
} catch (error) {
  failure = error;
  throw error;
} finally {
  const closed = await Promise.allSettled([admission?.configuration.close(), operation?.close(), scope.close()]);
  const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Native application preflight cleanup failed.');
}
