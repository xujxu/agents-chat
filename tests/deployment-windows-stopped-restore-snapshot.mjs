import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, verifySnapshot } from '../scripts/deployment/snapshot.mjs';
import { inspectSnapshotScope } from '../scripts/deployment/snapshot-scope.mjs';

export async function captureStoppedRestoreSnapshot({ control, project, state, recovery, pwsh, context }) {
  const original = JSON.parse(await readFile(path.join(control, 'task-maintenance', 'admission.json'), 'utf8'));
  await writeFile(path.join(project, '.env.local'),
    'NEXTAUTH_SECRET=stopped-restore-fixture\nNEXTAUTH_URL=http://localhost:3010\n'
    + 'ADMIN_USERNAME=fixture\nADMIN_PASSWORD=stopped-restore-fixture\n', { flag: 'wx' });
  const scope = await inspectSnapshotScope({ project });
  const configuration = JSON.parse(await readFile(original.configuration, 'utf8'));
  const runtimeFiles = ['configuration.json', ...Object.keys(configuration.helpers)]
    .map(name => path.join(path.dirname(original.configuration), name))
    .filter(file => {
      const relative = path.relative(project, file);
      return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
    });
  const snapshot = await createSnapshot({
    project, destination: path.join(control, 'backup'), id: state.backupId,
    source: { commit: state.targetCommit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
    pwsh, ...scope, externalFiles: runtimeFiles.map(file => ({ path: file, optional: false })),
    runtime: { platform: 'win32', state: 'stopped', task: {
      version: 1, name: original.taskName, definition: original.definition,
      securityDescriptor: original.securityDescriptor, configuration: original.configuration,
      configurationSha256: original.configurationSha256,
    } },
    async checkSource() { await context.check(); await scope.check(); },
  });
  assert.equal(snapshot.id, state.backupId);
  assert.deepEqual(await verifySnapshot(path.join(control, 'backup')), snapshot);
  await writeFile(path.join(project, '.env.local'), 'interrupted restore: invalid dotenv $value\n');
}

export async function verifyStoppedRestoreSnapshot({ control, pwsh, admission, proof }) {
  const { inspectWindowsStoppedRestoreSnapshot } = await import('../scripts/deployment/windows-stopped-restore-snapshot.mjs');
  const state = JSON.parse(await readFile(path.join(control, 'state.json'), 'utf8'));
  const options = { control, project: state.project, backup: path.join(control, 'backup'),
    node: process.execPath, pwsh, admission, proof, profile: 'agents-chat-auth-638c553' };
  for (const change of [
    { proof: { ...proof } }, { admission: {} }, { project: `${state.project}-foreign` },
    { backup: control }, { node: pwsh }, { profile: 'unsupported-profile' },
    { signal: AbortSignal.abort() },
  ]) await assert.rejects(inspectWindowsStoppedRestoreSnapshot({ ...options, ...change }));
  const observed = await inspectWindowsStoppedRestoreSnapshot(options);
  assert.equal(observed.mutationAuthority, false);
  assert.equal(observed.snapshot.id, state.backupId);
  assert.equal(observed.snapshot.source.commit, state.targetCommit);
  assert.deepEqual(observed.providers, ['admin-login']);
  assert.deepEqual(observed.authorizedPaths, observed.snapshot.externalFiles.map(file => file.path).sort());
  assert.equal(observed.recovery.manifestSha256, observed.snapshot.recoveryEngine);
  assert.equal(observed.runtime.task.name, proof.observation.taskName);
  await observed.check();
  assert.equal(await readFile(path.join(state.project, '.env.local'), 'utf8'),
    'interrupted restore: invalid dotenv $value\n');
  const { compareWindowsRestoreTaskPolicy } = await import('../scripts/deployment/windows-restore-task-policy.mjs');
  const original = JSON.parse(await readFile(path.join(control, 'task-maintenance', 'admission.json'), 'utf8'));
  for (const change of [
    { name: `${original.taskName}-foreign` },
    { securityDescriptor: `${original.securityDescriptor}S:` },
    { definition: '<invalid' },
    { definition: observed.runtime.task.definition.replace(/(<Settings>)/, '$1<Enabled>false</Enabled>') },
  ]) {
    if (change.definition) assert.notEqual(change.definition, observed.runtime.task.definition);
    await assert.rejects(compareWindowsRestoreTaskPolicy({
      original, task: { ...observed.runtime.task, ...change }, pwsh, check: () => proof.check(),
    }), { code: 'DEPLOYMENT_WINDOWS_RESTORE_POLICY_REFUSED' });
    await proof.check();
  }
  const engineManifest = JSON.parse(await readFile(path.join(observed.recovery.directory, 'manifest.json'), 'utf8'));
  const helper = path.join(observed.recovery.directory, engineManifest.files[0].name);
  const helperBytes = await readFile(helper);
  try {
    await writeFile(helper, 'throw new Error("changed recovery helper");\n');
    await assert.rejects(observed.check(), /integrity/);
    await assert.rejects(inspectWindowsStoppedRestoreSnapshot(options), /integrity/);
  } finally { await writeFile(helper, helperBytes); }
  await observed.check();
  const manifest = path.join(options.backup, 'manifest.json');
  const bytes = await readFile(manifest);
  try {
    const changed = JSON.parse(bytes);
    changed.id = 'foreign-backup';
    await writeFile(manifest, JSON.stringify(changed));
    await assert.rejects(observed.check());
    await assert.rejects(inspectWindowsStoppedRestoreSnapshot(options));
  } finally { await writeFile(manifest, bytes); }
  await observed.check();
  await proof.close();
  await assert.rejects(observed.check());
  console.log('PASS: stopped restore snapshot binds original backup, source, engine, archived policy and providers without mutation authority');
}
