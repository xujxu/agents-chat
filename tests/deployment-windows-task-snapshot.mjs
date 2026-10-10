import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as stages from '../scripts/deployment/windows-task-transaction.mjs';
import { verifySnapshot } from '../scripts/deployment/snapshot.mjs';

export function createWindowsTaskSnapshotFixture({ observation, control, lock, configuration, recovery, sourceCommit, targetCommit, pwsh }) {
  const destination = path.join(control, 'backup');
  const stageOptions = context => ({ context, control, lock, sourceCommit });
  const requireStage = () => assert.equal(typeof stages.assertWindowsTaskSnapshotStage, 'function',
    'Missing original-task copying-stage snapshot authority API');
  return {
    async refuseEarly(context) {
      requireStage();
      await assert.rejects(stages.assertWindowsTaskSnapshotStage(stageOptions(context)), /copying|stage/i);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
    },
    async capture(context) {
      requireStage();
      const options = stageOptions(context);
      for (const change of [
        { context: { ...context } }, { lock: { ...lock, token: randomUUID() } }, { sourceCommit: targetCommit },
      ]) await assert.rejects(stages.assertWindowsTaskSnapshotStage({ ...options, ...change }));
      const interrupted = new AbortController();
      interrupted.abort(new Error('Snapshot stage cancelled'));
      await assert.rejects(stages.assertWindowsTaskSnapshotStage({
        ...options, signal: interrupted.signal,
      }), /Snapshot stage cancelled/);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      const binding = await stages.assertWindowsTaskSnapshotStage(options);
      const task = {
        version: 1, name: observation.taskName, definition: observation.definition,
        securityDescriptor: observation.securityDescriptor, configuration: observation.configuration,
        configurationSha256: observation.configurationSha256,
      };
      assert.deepEqual(binding, { project: lock.project, sourceCommit, task });
      const { createWindowsTaskSnapshot } = await import('../scripts/deployment/windows-task-snapshot.mjs');
      const snapshotOptions = {
        context, control, lock, configuration, destination, pwsh, id: 'native-task-snapshot',
        source: { commit: sourceCommit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
      };
      await assert.rejects(createWindowsTaskSnapshot({ ...snapshotOptions, context: { ...context } }));
      for (const executable of [undefined, 'pwsh.exe']) {
        await assert.rejects(createWindowsTaskSnapshot({ ...snapshotOptions, pwsh: executable }), /PowerShell/);
      }
      await assert.rejects(createWindowsTaskSnapshot({ ...snapshotOptions, signal: interrupted.signal }),
        /Snapshot stage cancelled/);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      const original = await lstat(lock.project, { bigint: true });
      const manifest = await createWindowsTaskSnapshot(snapshotOptions);
      assert.equal(manifest.version, 3);
      assert.equal(manifest.scope, 'project');
      assert.equal(manifest.source.commit, sourceCommit);
      assert.equal(manifest.recoveryEngine, recovery.manifestSha256);
      assert.deepEqual(manifest.runtime, { platform: 'win32', state: 'stopped', task });
      assert.ok(manifest.windowsSecurity);
      assert.ok(manifest.gitMetadata);
      assert.ok(manifest.gitObjects);
      assert.doesNotMatch(JSON.stringify(manifest), /fixture-private-config/);
      const bytes = await readFile(observation.configuration);
      const runtime = JSON.parse(bytes);
      const expectedFiles = [observation.configuration,
        ...Object.keys(runtime.helpers).map(name => path.join(path.dirname(observation.configuration), name))];
      const { inspectWindowsSnapshotRuntime } = await import('../scripts/deployment/windows-snapshot-runtime.mjs');
      const runtimeOptions = { backup: destination, snapshot: manifest, project: lock.project, taskName: observation.taskName };
      const archived = await inspectWindowsSnapshotRuntime(runtimeOptions);
      assert.deepEqual(archived.task, task);
      assert.deepEqual(archived.configuration, runtime);
      assert.deepEqual(archived.files.map(file => file.name), expectedFiles.map(file => path.basename(file)));
      for (const change of [
        { project: path.join(lock.project, 'other') }, { taskName: `${observation.taskName}-other` },
        { snapshot: { ...manifest, id: 'changed-expected-snapshot' } }, { backup: lock.project },
      ]) await assert.rejects(inspectWindowsSnapshotRuntime({ ...runtimeOptions, ...change }));
      await assert.rejects(inspectWindowsSnapshotRuntime({ ...runtimeOptions, signal: interrupted.signal }),
        /Snapshot stage cancelled/);
      const external = [];
      for (const [position, file] of expectedFiles.entries()) {
        const relative = path.relative(lock.project, file);
        let archivedFile;
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
          external.push(file);
          const index = manifest.externalFiles.findIndex(entry => entry.path === file);
          assert.ok(index >= 0);
          archivedFile = path.join(destination, 'external', String(index));
        } else {
          assert.ok(manifest.entries.some(entry => entry.path === relative.split(path.sep).join('/')));
          archivedFile = path.join(destination, 'files', relative);
        }
        assert.equal(archived.files[position].file, archivedFile);
        assert.equal(archived.files[position].sha256, position === 0 ? task.configurationSha256 : runtime.helpers[path.basename(file)]);
        assert.deepEqual(await readFile(archivedFile), await readFile(file));
      }
      assert.deepEqual(manifest.externalFiles.map(file => file.path).sort(), external.sort());
      if (external.length) {
        assert.equal(manifest.windowsExternalSecurity.parents.length, 1);
        assert.equal(manifest.windowsExternalSecurity.parents[0].metadata.entries.length, external.length);
      } else {
        assert.equal(manifest.windowsExternalSecurity, undefined);
      }
      assert.equal(await readFile(path.join(destination, 'files/source-marker.txt'), 'utf8'), 'old-source\n');
      assert.deepEqual(await readFile(path.join(destination, 'files/.env.local')), await readFile(path.join(lock.project, '.env.local')));
      assert.ok(manifest.absentPaths.includes('.env.production.local'));
      const current = await lstat(lock.project, { bigint: true });
      assert.equal(current.dev, original.dev);
      assert.equal(current.ino, original.ino);
      assert.deepEqual(await verifySnapshot(destination), manifest);
      await archived.check();
      await configuration.checkFiles();
      await context.check();
      return manifest;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const control = process.argv[2];
  const manifest = await verifySnapshot(path.join(control, 'backup'));
  const state = JSON.parse(await readFile(path.join(control, 'state.json')));
  assert.equal(manifest.id, 'native-task-snapshot');
  assert.equal(state.phase, 'accepted');
  assert.equal(state.backupId, manifest.id);
  assert.equal(state.sourceCommit, manifest.source.commit);
  assert.notEqual(state.targetCommit, manifest.source.commit);
  const { verifyRecoveryEngine } = await import('../scripts/deployment/saved-recovery-engine.mjs');
  const saved = await verifyRecoveryEngine({ control, manifestSha256: manifest.recoveryEngine });
  const { inspectWindowsSnapshotRuntime } = await import(pathToFileURL(path.join(saved.directory, 'windows-snapshot-runtime.mjs')));
  const archived = await inspectWindowsSnapshotRuntime({
    backup: path.join(control, 'backup'), snapshot: manifest, project: manifest.project, taskName: manifest.runtime.task.name,
  });
  assert.deepEqual(archived.task, manifest.runtime.task);
  assert.equal(archived.configuration.command.cwd, manifest.project);
  await archived.check();
  assert.equal(await readFile(path.join(control, 'backup/files/source-marker.txt'), 'utf8'), 'old-source\n');
  assert.equal(await readFile(path.join(manifest.project, 'source-marker.txt'), 'utf8'), 'new-source\n');
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  console.log('PASS: native original-task snapshot remains complete after update, activation and final unlock');
}
