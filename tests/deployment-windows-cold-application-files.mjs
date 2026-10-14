import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWindowsRestoredProjectBytes } from './deployment-windows-restore-evidence.mjs';
import { verifyWindowsApplicationApi, verifyWindowsColdLaunchApi } from './deployment-windows-application-api-helpers.mjs';
import { interruptWindowsColdApplication } from './deployment-windows-cold-application-recovery.mjs';

export async function verifyWindowsColdApplicationFiles({
  directory, project, control, backup, snapshot, pwsh, chatId, interruptStartup = false, interruptLaunch = false,
}) {
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { claimWindowsColdRestore } = await captured('windows-cold-restore-lease.mjs');
  const { restoreWindowsColdFiles } = await captured('windows-cold-restore-files.mjs');
  const { verifySnapshot } = await captured('snapshot.mjs');
  const lock = await readFile(path.join(control, 'lock', 'owner.json'));
  const state = await readFile(path.join(control, 'state.json'));
  const receipt = await readFile(path.join(control, 'deployment.json'));
  const proof = JSON.parse(await readFile(path.join(control, 'restore-crash-fixture.json'), 'utf8'));
  assert.equal(proof.scenario, 'copy-crashed');
  assert.notEqual(proof.lock.pid, process.pid);
  await assert.rejects(lstat(path.join(project, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')),
    { code: 'ENOENT' });
  const bundles = (await readdir(control)).filter(name => name.startsWith('runtime-')).sort();
  const originals = await Promise.all(snapshot.externalFiles.map(async entry => {
    let identity;
    try { identity = await lstat(entry.path, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { file: entry.path, bytes: identity ? await readFile(entry.path) : null, identity };
  }));
  process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: claiming original interrupted snapshot\n`);
  const lease = await claimWindowsColdRestore({
    control, project, backup, node: process.execPath, pwsh,
    profile: 'agents-chat-auth-638c553', acceptDataLoss: true,
  });
  let configuration;
  try {
    const restored = await restoreWindowsColdFiles({
      control, lease, acceptDataLoss: true,
      onProgress({ stage }) {
        process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: ${stage}\n`);
      },
    });
    assert.equal(restored.status, 'files-restored');
    assert.equal(restored.runtimeBundle.directory, path.join(control, `runtime-${lease.owner.operationId}`));
    assert.deepEqual((await readdir(control)).filter(name => name.startsWith('runtime-')).sort(),
      [...bundles, `runtime-${lease.owner.operationId}`].sort());
    const ownerBytes = await readFile(path.join(control, 'recovery-lock/owner.json'));
    const filesReceipt = await readFile(path.join(control, 'recovery-lock/files-restored.json'));
    process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: retaining snapshot-bound startup configuration\n`);
    configuration = await lease.inspectRestoredConfiguration();
    assert.deepEqual(configuration.providers, lease.providers);
    process.stderr.write(`${new Date().toISOString()} Actual cold file restoration: retiring original stopped runtime\n`);
    const retired = await lease.retireRuntime();
    assert.deepEqual(retired, { retired: true, inhibited: true, operationId: lease.owner.operationId });
    await configuration.checkFiles();
    await assertWindowsRestoredProjectBytes(project, backup);
    assert.ok(snapshot.entries.some(entry => entry.path === '.data/chats.db' && entry.kind === 'file'));
    assert.deepEqual(await readFile(path.join(project, '.data/chats.db')),
      await readFile(path.join(backup, 'files/.data/chats.db')));
    for (const original of originals) {
      if (!original.identity) {
        await assert.rejects(lstat(original.file), { code: 'ENOENT' });
        continue;
      }
      assert.deepEqual(await readFile(original.file), original.bytes);
      const current = await lstat(original.file, { bigint: true });
      assert.equal(current.dev, original.identity.dev);
      assert.equal(current.ino, original.identity.ino);
    }
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lock);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await readFile(path.join(control, 'recovery-lock/owner.json')), ownerBytes);
    assert.deepEqual(await readFile(path.join(control, 'recovery-lock/files-restored.json')), filesReceipt);
    await lease.checkStopped();
    await configuration.checkFiles();
    process.stderr.write(`${new Date().toISOString()} Actual cold restoration: starting guarded archived application\n`);
    const activation = await lease.prepareActivation({ configuration });
    const running = await activation.start({
      async onProgress(progress) {
        if (!interruptLaunch || progress.step !== 'observed') return;
        const readiness = await verifyWindowsColdLaunchApi({ pwsh, runtime: progress.observation.runtime, chatId, directory });
        await configuration.checkFiles();
        await assert.rejects(lstat(path.join(control, 'recovery-lock/activation-running.json')), { code: 'ENOENT' });
        const requested = JSON.parse(await readFile(path.join(control, 'recovery-lock/activation-start-requested.json')));
        assert.equal(requested.runtime, null);
        assert.equal(requested.controllerPid, progress.observation.controllerPid);
        const launch = JSON.parse(await readFile(path.join(path.dirname(progress.observation.configuration),
          `launch-${progress.observation.runtime.identity.replace(':', '-')}.json`)));
        const runtime = progress.observation.runtime;
        assert.deepEqual(launch, {
          version: 1, generation: runtime.generation, pid: runtime.pid, identity: runtime.identity,
          configurationSha256: runtime.configurationSha256, sessionId: runtime.sessionId,
          job: `Local\\agents-deploy-${runtime.generation}`,
          controllerPid: progress.observation.controllerPid, controllerIdentity: progress.observation.controllerIdentity,
        });
        for (const [name, bytes] of [['state.json', state], ['lock/owner.json', lock], ['deployment.json', receipt]]) {
          assert.deepEqual(await readFile(path.join(control, name)), bytes);
        }
        await interruptWindowsColdApplication({
          status: 'cold-launch-interrupted', retired: true, runtime: proof.runtime,
          activation: progress.observation, readiness,
        });
        assert.fail('Actual unacknowledged launch interruption unexpectedly returned.');
      },
    });
    assert.equal(interruptLaunch, false, 'Actual cold startup skipped its unacknowledged launch boundary.');
    const readiness = await activation.waitReady({ port: 3010 });
    assert.equal(readiness.generation, running.runtime.generation);
    await verifyWindowsApplicationApi('restored', chatId);
    if (interruptStartup) {
      await activation.check();
      await configuration.checkFiles();
      await assert.rejects(lstat(path.join(control, 'recovery-lock/completion-release-requested.json')), { code: 'ENOENT' });
      await interruptWindowsColdApplication({
        status: 'cold-startup-interrupted', retired: true, runtime: proof.runtime, activation: running, readiness,
      });
      assert.fail('Actual guarded startup interruption unexpectedly returned.');
    }
    await activation.check();
    await configuration.checkFiles();
    assert.deepEqual(await verifySnapshot(backup), snapshot);
    assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
    assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lock);
    assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
    assert.deepEqual(await readFile(path.join(control, 'recovery-lock/owner.json')), ownerBytes);
    assert.deepEqual(await readFile(path.join(control, 'recovery-lock/files-restored.json')), filesReceipt);
    process.stderr.write(`${new Date().toISOString()} Actual cold restoration: completing permanent task policy and releasing the original runtime lease\n`);
    await activation.completeRuntime({
      port: 3010,
      async onProgress(progress) {
        if (progress.step !== 'lease-released') return;
        assert.equal(progress.lease, 'released');
        await assert.rejects(lstat(path.join(control, 'recovery-lock/completion-released.json')), { code: 'ENOENT' });
        const requested = JSON.parse(await readFile(path.join(control, 'recovery-lock/completion-release-requested.json')));
        await verifyWindowsApplicationApi('restored', chatId);
        assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
        assert.deepEqual(await readFile(path.join(control, 'lock/owner.json')), lock);
        assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
        await interruptWindowsColdApplication({
          status: 'cold-completion-interrupted', retired: true, operationId: lease.owner.operationId,
          runtime: proof.runtime, activation: running, readiness, progress,
          definition: requested.definition, enabled: requested.enabled,
        });
      },
    });
    assert.fail('Actual cold completion skipped its interrupted release boundary.');
  } finally {
    const errors = [];
    try { await lease.close(); } catch (error) { errors.push(error); }
    try { await configuration?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Actual cold configuration and lease cleanup failed.');
  }
}

export async function verifyWindowsColdApplicationCompletion({ directory, control, pwsh, chatId }) {
  const captured = name => import(pathToFileURL(path.join(directory, 'scripts/deployment', name)));
  const { inspectWindowsColdRuntimeCompletion } = await captured('windows-cold-activation-recovery.mjs');
  const before = await Promise.all(['state.json', 'lock/owner.json', 'deployment.json']
    .map(name => readFile(path.join(control, name))));
  process.stderr.write(`${new Date().toISOString()} Actual cold restoration: independently observing released application after original controller exit\n`);
  const proof = await inspectWindowsColdRuntimeCompletion({ control, pwsh });
  let observation;
  try {
    observation = proof.observation;
    assert.equal(observation.status, 'cold-runtime-completed');
    assert.equal(observation.mutationAuthority, false);
    assert.equal(observation.lease, 'released');
    assert.equal(observation.port, 3010);
    assert.equal(proof.advance, undefined);
    assert.equal(proof.archive, undefined);
    await verifyWindowsApplicationApi('restored', chatId);
    assert.deepEqual(await proof.check(), observation);
  } finally { await proof.close(); }
  assert.deepEqual(await Promise.all(['state.json', 'lock/owner.json', 'deployment.json']
    .map(name => readFile(path.join(control, name)))), before);
  return { ...observation, status: 'cold-runtime-observed' };
}
