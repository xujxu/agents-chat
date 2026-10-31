import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function interruptPublication({ control, configuration, sha256, directory, pwsh }) {
  const load = name => import(pathToFileURL(path.join(control, 'recovery-engine', name)).href);
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { processIdentity } = await load('process-identity.mjs');
  const controllerIdentity = await processIdentity(process.pid);
  assert.ok(controllerIdentity);
  const bridge = windowsControllerTransport({
    pwsh, label: 'Interrupted runtime publication fixture',
    refused: cause => new Error('Interrupted runtime publication fixture failed.', { cause }),
    args: ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./deployment-windows-runtime-publication-crash.ps1', import.meta.url)),
      '-Script', path.join(control, 'recovery-engine', 'windows-runtime-publication.ps1'),
      '-Configuration', configuration, '-Sha256', sha256, '-Directory', directory,
      '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
  });
  try {
    const held = await bridge.wire.receive({ timeoutMs: 60000 });
    assert.equal(held.type, 'publication-held');
    assert.equal(held.pid, bridge.child.pid);
    assert.equal(held.processIdentity, await processIdentity(held.pid));
    await assert.rejects(access(path.join(directory, 'configuration.json')), { code: 'ENOENT' });
    assert.equal(bridge.child.kill(), true);
    const result = await bridge.waitForExit();
    assert.ok(result.signal !== null || result.code !== 0, 'Publisher must actually die before publication');
    assert.notEqual(await processIdentity(held.pid), held.processIdentity);
    bridge.wire.close();
  } catch (cause) { throw await bridge.abandon(cause); }
}

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
    const partial = path.join(control, 'runtime-resumption-fixture');
    await interruptPublication({
      control, configuration: scope.observation.configuration,
      sha256: scope.observation.configurationSha256, directory: partial, pwsh,
    });
    const partialNames = (await readdir(partial)).sort();
    assert.equal(partialNames.length, 1, 'Publisher must die after the first helper copy');
    const helper = partialNames[0];
    assert.ok(Object.hasOwn(JSON.parse(bytes).helpers, helper));
    const target = path.join(partial, helper);
    const helperBytes = await readFile(path.join(directory, helper));
    assert.deepEqual(await readFile(target), helperBytes);
    const retained = await lstat(target, { bigint: true });
    const resume = () => publication.publishWindowsRuntimeBundle({
      directory: partial, sourceConfiguration: scope.observation.configuration,
      sha256: scope.observation.configurationSha256, pwsh, resumeExisting: true,
      check: () => scope.check(),
    });
    const foreign = path.join(partial, 'foreign-fixture.json');
    await writeFile(foreign, '{}', { flag: 'wx' });
    try {
      await assert.rejects(resume(), { code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED' });
      assert.deepEqual((await readdir(partial)).sort(), [...partialNames, path.basename(foreign)].sort());
    } finally { await unlink(foreign); }
    await writeFile(target, 'invalid helper');
    try {
      await assert.rejects(resume(), { code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED' });
      assert.deepEqual((await readdir(partial)).sort(), partialNames);
      assert.equal(await readFile(target, 'utf8'), 'invalid helper');
    } finally { await writeFile(target, helperBytes); }
    const invalidConfiguration = path.join(partial, 'configuration.json');
    await writeFile(invalidConfiguration, '{}', { flag: 'wx' });
    try {
      await assert.rejects(resume(), { code: 'DEPLOYMENT_WINDOWS_RUNTIME_PUBLICATION_REFUSED' });
      assert.deepEqual((await readdir(partial)).sort(), [...partialNames, 'configuration.json'].sort());
      assert.equal(await readFile(invalidConfiguration, 'utf8'), '{}');
      assert.deepEqual(await readFile(target), helperBytes);
    } finally { await unlink(invalidConfiguration); }
    const resumed = await resume();
    assert.deepEqual(resumed, {
      directory: partial, configuration: path.join(partial, 'configuration.json'),
      sha256: scope.observation.configurationSha256,
    });
    assert.deepEqual((await readdir(partial)).sort(), (await readdir(directory)).sort());
    for (const name of await readdir(directory)) {
      assert.deepEqual(await readFile(path.join(partial, name)), await readFile(path.join(directory, name)));
    }
    assert.deepEqual(await resume(), resumed);
    const after = await lstat(target, { bigint: true });
    assert.equal(after.dev, retained.dev);
    assert.equal(after.ino, retained.ino);
    assert.deepEqual(await readFile(scope.observation.configuration), bytes);
    assert.deepEqual(await readFile(stateFile), state);
    assert.deepEqual(await scope.check(), scope.observation);
    console.error(`PASS: private runtime publication survives real publisher death before configuration, repairs only missing members, refuses foreign authority and never overwrites an existing bundle or changes the ${inactive ? 'inactive' : 'running'} task`);
    return bundle;
  } finally { await scope.close(); }
}
