import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsRestorePolicy({ directory, control, project, task, pwsh }) {
  const { inspectWindowsManagedTask } = await import(pathToFileURL(path.join(directory, 'windows-managed-task.mjs')));
  const { inspectWindowsRestoreTaskPolicy } = await import(pathToFileURL(path.join(directory, 'windows-restore-task-policy.mjs')));
  const scope = await inspectWindowsManagedTask({ project, taskName: task.name, pwsh });
  let failure;
  try {
    const original = scope.observation;
    assert.notEqual(original.configuration, task.configuration, 'Restore fixture must compare distinct runtime bundles.');
    const options = { scope, task, pwsh };
    assert.deepEqual(await inspectWindowsRestoreTaskPolicy(options), {
      status: 'same-task-policy', runtimeAuthority: false, taskName: task.name,
    });
    await assert.rejects(inspectWindowsRestoreTaskPolicy({ ...options, scope: { ...scope } }));
    const changes = [
      { name: `${task.name}-foreign` },
      { securityDescriptor: `${task.securityDescriptor}S:` },
      { definition: '<invalid' },
      { definition: task.definition.replace(/(<Settings>[\s\S]*?<Enabled>)(true|false)(<\/Enabled>)/,
        (_, before, enabled, after) => `${before}${enabled === 'true' ? 'false' : 'true'}${after}`) },
      { definition: task.definition.replace(/BootTrigger/g, 'LogonTrigger') },
      { definition: task.definition.replace(/<UserId>[^<]+<\/UserId>/, '<UserId>S-1-5-18</UserId>') },
      { definition: task.definition.replace(/(<MultipleInstancesPolicy>)([^<]+)(<\/MultipleInstancesPolicy>)/,
        (_, before, policy, after) => `${before}${policy === 'Parallel' ? 'IgnoreNew' : 'Parallel'}${after}`) },
    ];
    for (const change of changes) {
      if (Object.hasOwn(change, 'definition')) assert.notEqual(change.definition, task.definition);
      await assert.rejects(inspectWindowsRestoreTaskPolicy({ ...options, task: { ...task, ...change } }),
        { code: 'DEPLOYMENT_WINDOWS_RESTORE_POLICY_REFUSED' });
      assert.deepEqual(await scope.check(), original);
      await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
    }
    const cancellation = new AbortController();
    cancellation.abort(new Error('Restore policy inspection cancelled'));
    await assert.rejects(inspectWindowsRestoreTaskPolicy({ ...options, signal: cancellation.signal }),
      /Restore policy inspection cancelled/);
    assert.deepEqual(await scope.check(), original);
    console.log('PASS: saved restore policy comparison permits runtime-action indirection and rejects policy changes without mutating the live task');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await scope.close(); }
    catch (cleanup) {
      throw new AggregateError(failure ? [failure, cleanup] : [cleanup], 'Restore policy fixture and observation cleanup failed.');
    }
  }
}
