import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyWindowsRuntimePublication({ control, project, taskName, lock, node, pwsh, inactive = false }) {
  const entry = path.join(control, 'recovery-engine', 'windows-runtime-publication.mjs');
  await assert.doesNotReject(access(entry), 'Missing saved original runtime bundle publisher');
  const publication = await import(pathToFileURL(entry).href);
  const prepareWindowsRuntimeBundle = inactive ? publication.prepareWindowsInactiveRuntimeBundle : publication.prepareWindowsRuntimeBundle;
  assert.equal(typeof prepareWindowsRuntimeBundle, 'function', 'Missing runtime publication for selected task state');
  const discovery = await import(pathToFileURL(path.join(control, 'recovery-engine', 'windows-managed-task.mjs')).href);
  const inspect = inactive ? discovery.inspectWindowsInactiveTask : discovery.inspectWindowsManagedTask;
  const scope = await inspect({ taskName, project, pwsh });
  const directory = path.join(control, `runtime-${lock.operationId}`);
  const stateFile = path.join(control, 'state.json');
  const state = await readFile(stateFile);
  const bytes = await readFile(scope.observation.configuration);
  try {
    const input = { scope, control, lock, node, pwsh };
    await assert.rejects(prepareWindowsRuntimeBundle({ ...input, signal: AbortSignal.abort() }));
    await assert.rejects(prepareWindowsRuntimeBundle({ ...input, scope: { ...scope } }));
    await assert.rejects(prepareWindowsRuntimeBundle({ ...input, lock: { ...lock, operationId: randomUUID() } }));
    await assert.rejects(access(directory), { code: 'ENOENT' });
    const bundle = await prepareWindowsRuntimeBundle(input);
    assert.deepEqual(bundle, {
      directory, configuration: path.join(directory, 'configuration.json'),
      sha256: scope.observation.configurationSha256,
    });
    assert.notEqual(bundle.configuration, scope.observation.configuration);
    assert.deepEqual(await readFile(bundle.configuration), bytes);
    assert.deepEqual((await readdir(directory)).sort(), [...Object.keys(JSON.parse(bytes).helpers), 'configuration.json'].sort());
    await assert.rejects(prepareWindowsRuntimeBundle(input));
    assert.deepEqual(await readFile(bundle.configuration), bytes);
    assert.deepEqual(await readFile(scope.observation.configuration), bytes);
    assert.deepEqual(await readFile(stateFile), state);
    assert.deepEqual(await scope.check(), scope.observation);
    console.error(`PASS: private runtime publication preserves exact configuration and helpers, refuses foreign authority and never overwrites an existing bundle or changes the ${inactive ? 'inactive' : 'running'} task`);
    return bundle;
  } finally { await scope.close(); }
}
