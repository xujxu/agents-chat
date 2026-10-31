import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createSnapshot } from '../scripts/deployment/snapshot.mjs';
import { projectSnapshotExclusions } from '../scripts/deployment/snapshot-scope.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('public Windows restore invocation verifies historical bytes without importing or changing them', {
  skip: process.platform !== 'win32',
}, async t => {
  const { prepareWindowsRestoreInvocation } = await import('../scripts/deployment/windows-restore-invocation.mjs');
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'installed app');
  const control = path.join(root, '.installed app.deployment');
  const backup = path.join(control, 'backup');
  const engine = path.join(control, 'recovery-engine');
  const taskName = 'Agents-Public-Restore-Test';
  const pwsh = process.env.DEPLOYMENT_TEST_PWSH;
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  await mkdir(engine, { mode: 0o700 });
  const files = [];
  for (const name of ['linux-restore-entry.mjs', 'windows-restore-entry.mjs', 'saved-recovery-engine.mjs']) {
    const bytes = Buffer.from('throw new Error("Admission must not import historical code");\n');
    await writeFile(path.join(engine, name), bytes, { mode: 0o600 });
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifestFile = path.join(engine, 'manifest.json');
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, files }));
  await writeFile(manifestFile, manifestBytes, { mode: 0o600 });
  const recoveryEngine = hash(manifestBytes);
  await writeFile(path.join(project, 'fixture.txt'), 'historical data\n');
  const snapshotOptions = {
    project, destination: backup, id: 'historical-windows-engine', files: ['fixture.txt'],
    source: { commit: 'a'.repeat(40), provenance: 'observed' }, recoveryEngine,
    runtime: { platform: 'win32', state: 'stopped', task: { name: taskName } },
    projectScope: true, excludedPaths: projectSnapshotExclusions,
  };
  await createSnapshot(snapshotOptions);
  const options = { project, taskName, pwsh, waitSeconds: 120, timeoutSeconds: 60 };
  const before = (await readdir(control)).sort();
  const invocation = await prepareWindowsRestoreInvocation(options);
  assert.equal(invocation.file, process.execPath);
  assert.equal(invocation.backupId, 'historical-windows-engine');
  assert.deepEqual(invocation.args, [
    path.join(engine, 'windows-restore-entry.mjs'), control, recoveryEngine, '--accept-data-loss',
  ]);
  assert.deepEqual(invocation.input, { ...options, backup, port: 3010 });
  assert.deepEqual((await readdir(control)).sort(), before);
  for (const change of [
    { taskName: 'Different-Task' }, { timeoutSeconds: 0 }, { waitSeconds: 0 },
    { pwsh: path.join(project, 'pwsh.exe') }, { project: path.join(root, 'other') },
  ]) await assert.rejects(prepareWindowsRestoreInvocation({ ...options, ...change }));
  const helper = path.join(engine, 'windows-restore-entry.mjs');
  const original = await readFile(helper);
  await writeFile(helper, 'corrupted helper');
  await assert.rejects(prepareWindowsRestoreInvocation(options), /integrity/i);
  await writeFile(helper, original);
  await writeFile(manifestFile, JSON.stringify({ version: 1, files: [...files].reverse() }));
  await assert.rejects(prepareWindowsRestoreInvocation(options), /digest/i);
  await writeFile(manifestFile, manifestBytes);
  const oldManifest = Buffer.from(JSON.stringify({
    version: 1, files: files.filter(file => file.name !== 'windows-restore-entry.mjs'),
  }));
  await rename(helper, path.join(root, 'held-helper.mjs'));
  await writeFile(manifestFile, oldManifest);
  await rename(backup, `${backup}.held`);
  await createSnapshot({ ...snapshotOptions, recoveryEngine: hash(oldManifest) });
  await assert.rejects(prepareWindowsRestoreInvocation(options), { code: 'DEPLOYMENT_SAVED_RESTORE_UNSUPPORTED' });
  await rename(backup, path.join(root, 'unsupported-backup'));
  await rename(`${backup}.held`, backup);
  await writeFile(manifestFile, manifestBytes);
  await rename(path.join(root, 'held-helper.mjs'), helper);
  await rename(backup, `${backup}.held`);
  await assert.rejects(prepareWindowsRestoreInvocation(options), { code: 'DEPLOYMENT_BACKUP_MISSING' });
  await rename(`${backup}.held`, backup);
  await writeFile(path.join(engine, 'extra.mjs'), '', { mode: 0o600 });
  await assert.rejects(prepareWindowsRestoreInvocation(options), /inventory/i);
  assert.deepEqual((await readdir(control)).sort(), before);
});
