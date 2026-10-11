import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsRestoreAdmission({ directory, control, snapshot, pwsh }) {
  const load = name => import(pathToFileURL(path.join(directory, name)));
  const { admitWindowsRestore } = await load('windows-restore-compatibility.mjs');
  const { inspectWindowsManagedTask } = await load('windows-managed-task.mjs');
  const scope = await inspectWindowsManagedTask({ project: snapshot.project, taskName: snapshot.runtime.task.name, pwsh });
  const state = await readFile(path.join(control, 'state.json'));
  const options = { scope, backup: path.join(control, 'backup'), snapshot, node: process.execPath, pwsh,
    profile: 'agents-chat-auth-638c553' };
  let admission;
  const errors = [];
  try {
    for (const change of [
      { scope: { ...scope } }, { node: pwsh }, { node: 'node.exe' },
      { snapshot: { ...snapshot, id: 'foreign-snapshot' } }, { profile: 'unsupported-profile' },
      { signal: AbortSignal.abort() },
    ]) await assert.rejects(admitWindowsRestore({ ...options, ...change }));
    admission = await admitWindowsRestore(options);
    assert.deepEqual(admission.snapshot, snapshot);
    assert.deepEqual(admission.providers, ['admin-login']);
    assert.deepEqual([...admission.authorizedPaths].sort(), snapshot.externalFiles.map(file => file.path).sort());
    assert.equal(admission.configurationProfile, options.profile);
    assert.equal(admission.runtime.configuration.command.cwd, snapshot.project);
    assert.equal(admission.runtime.task.configurationSha256, snapshot.runtime.task.configurationSha256);
    await admission.check();
    await admission.checkSnapshot();
    assert.deepEqual(await scope.check(), scope.observation);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    console.log('PASS: saved Windows restore admission binds archived providers, original task policy, external destinations and Node without mutating the live deployment');
  } catch (error) { errors.push(error); }
  try { await admission?.close(); } catch (error) { errors.push(error); }
  try { await scope.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Windows restore admission fixture or cleanup failed.');
}
