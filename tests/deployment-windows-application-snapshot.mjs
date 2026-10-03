import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLock, writeState } from '../scripts/deployment/state.mjs';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { inspectWindowsManagedTask, captureWindowsManagedTaskAdmission } from '../scripts/deployment/windows-managed-task.mjs';
import { inspectWindowsConfiguration } from '../scripts/deployment/windows-configuration.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';
import { stopWindowsTaskTransaction } from '../scripts/deployment/windows-task-transaction.mjs';
import { createWindowsTaskSnapshot } from '../scripts/deployment/windows-task-snapshot.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

const [project, taskName, pwsh, git, control] = process.argv.slice(2);
const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
let configuration;
let context;
let failure;
try {
  const observed = scope.observation;
  const runtimeBytes = await readFile(observed.configuration);
  assert.equal(createHash('sha256').update(runtimeBytes).digest('hex'), observed.configurationSha256);
  const runtime = JSON.parse(runtimeBytes);
  assert.equal(await realpath(runtime.command.file), await realpath(process.execPath));
  const { stdout } = await promisify(execFile)(git, [
    '--no-optional-locks', '--no-replace-objects', '-C', project, 'rev-parse', 'HEAD',
  ], { timeout: 30000, maxBuffer: 1024 });
  const commit = stdout.trim();
  const target = await inspectTargetCompatibility({
    project, commit, nodeVersion: process.versions.node, platform: process.platform, git,
  });
  configuration = await inspectWindowsConfiguration({ scope, pwsh, profile: target.configurationProfile });
  assert.deepEqual(configuration.providers, ['admin-login']);
  const lock = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
  const recovery = await saveRecoveryEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), control,
  });
  let state = {
    version: 1, operationId: lock.operationId, project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: commit, targetCommit: commit,
    backupId: null, priorRuntime: 'running', runtimeIdentity: observed.runtime.generation,
    startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: null,
  };
  await writeState(control, state);
  const captured = await withWindowsAdmission(control, { pwsh }, admission =>
    captureWindowsManagedTaskAdmission({ scope, control, lock, admission }));
  state = { ...state, phase: 'stopped', previousPhase: state.phase, updatedAt: new Date().toISOString() };
  await writeState(control, state);
  context = await stopWindowsTaskTransaction({ control, lock, pwsh, ...captured });
  state = { ...state, phase: 'copying', previousPhase: state.phase, updatedAt: new Date().toISOString() };
  await writeState(control, state);
  const destination = path.join(control, 'backup');
  const manifest = await createWindowsTaskSnapshot({
    context, control, lock, configuration, destination, pwsh, id: 'actual-application-snapshot',
    source: { commit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
  });
  assert.equal(manifest.version, 3);
  assert.equal(manifest.scope, 'project');
  assert.equal(manifest.source.commit, commit);
  assert.equal(manifest.recoveryEngine, recovery.manifestSha256);
  assert.deepEqual(manifest.runtime, { platform: 'win32', state: 'stopped', task: {
    version: 1, name: observed.taskName, definition: observed.definition,
    securityDescriptor: observed.securityDescriptor, configuration: observed.configuration,
    configurationSha256: observed.configurationSha256,
  } });
  assert.ok(manifest.windowsSecurity);
  assert.ok(manifest.gitMetadata);
  assert.ok(manifest.gitObjects);
  assert.doesNotMatch(JSON.stringify(manifest), /private-fixture-password|actions-isolated-build-fixture-secret/);
  const required = [
    '.next/BUILD_ID', 'node_modules/next/package.json',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node', '.data/chats.db',
  ];
  for (const name of required) assert.ok(manifest.entries.some(entry => entry.path === name), `Missing ${name}`);
  const data = manifest.entries.filter(entry => entry.kind === 'file' && entry.path.startsWith('.data/'));
  assert.ok(data.some(entry => entry.path === '.data/chats.db'));
  for (const name of new Set([...required, ...data.map(entry => entry.path)])) {
    assert.deepEqual(await readFile(path.join(destination, 'files', name)), await readFile(path.join(project, name)));
  }
  const external = [observed.configuration,
    ...Object.keys(runtime.helpers).map(name => path.join(path.dirname(observed.configuration), name))];
  assert.deepEqual(manifest.externalFiles.map(entry => entry.path).sort(), external.sort());
  assert.equal(manifest.windowsExternalSecurity.parents.length, 1);
  assert.equal(manifest.windowsExternalSecurity.parents[0].metadata.entries.length, external.length);
  for (const file of external) {
    const index = manifest.externalFiles.findIndex(entry => entry.path === file);
    assert.deepEqual(await readFile(path.join(destination, 'external', String(index))), await readFile(file));
  }
  assert.deepEqual(await verifySnapshot(destination), manifest);
  await configuration.checkFiles();
  await context.check();
  // This fixture stops at a verified snapshot, not a fabricated completed update.
  assert.equal(JSON.parse(await readFile(path.join(control, 'state.json'))).phase, 'copying');
  console.log(`PASS: complete actual Windows application snapshot verified ${manifest.entries.length} entries with Git, native dependencies, build, data and external runtime`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  const closed = await Promise.allSettled([context?.close(), configuration?.close(), scope.close()]);
  const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Actual application snapshot cleanup failed.');
}
