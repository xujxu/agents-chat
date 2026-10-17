import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const [source, taskName, project, pwsh, control, gitFile, npmFile, completionMode] = process.argv.slice(2);
const { inspectWindowsInactiveTask, assertWindowsManagedTaskScope, captureWindowsInactiveTaskAdmission } =
  await import(pathToFileURL(path.join(source, 'windows-managed-task.mjs')).href);
const scope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
try {
  assert.equal(scope.observation.status, 'inactive-task-observed');
  assert.equal(scope.observation.runtime, null);
  assert.equal(scope.observation.runtimeAuthority, false);
  assert.equal(scope.observation.enabled, false);
  assert.equal(Object.hasOwn(scope.observation.retiredRuntime, 'instanceGuid'), false);
  assert.equal(Object.hasOwn(scope, 'listener'), false);
  assert.deepEqual(await scope.check(), scope.observation);
  await assert.rejects(assertWindowsManagedTaskScope(scope), { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
  assert.deepEqual(await scope.check(), scope.observation);
} finally { await scope.close(); }
await scope.close();
await assert.rejects(scope.check(), { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
console.log('PASS: inactive task Node bridge retains native proof without active runtime or admission authority');

const { acquireLock, writeState, releaseLock } = await import(pathToFileURL(path.join(source, 'state.mjs')).href);
const { withWindowsAdmission } = await import(pathToFileURL(path.join(source, 'windows-admission.mjs')).href);
const { createWindowsInactiveTaskAdmissionRecord } =
  await import(pathToFileURL(path.join(source, 'windows-inactive-task-admission.mjs')).href);
const lock = await acquireLock(control, { project, pwsh, operationId: randomUUID() });
const admissionScope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
try {
  const state = {
    version: 1, operationId: lock.operationId, project, operation: 'update', phase: 'preflight',
    previousPhase: null, sourceCommit: null, targetCommit: null, backupId: null,
    priorRuntime: 'stopped', runtimeIdentity: admissionScope.observation.retiredRuntime.generation,
    startedAt: lock.createdAt, updatedAt: lock.createdAt, errorCode: null,
  };
  await writeState(control, state);
  const { saveRecoveryEngine } =
    await import(pathToFileURL(path.join(source, 'saved-recovery-engine.mjs')).href);
  const recovery = await saveRecoveryEngine({ control, source });
  const { verifyWindowsRuntimePublication } = await import('./deployment-windows-runtime-publication.mjs');
  const bundle = await verifyWindowsRuntimePublication({
    project, control, lock, pwsh, taskName, node: process.execPath, inactive: true,
  });
  const stateBytes = await readFile(path.join(control, 'state.json'));
  const lockBytes = await readFile(path.join(control, 'lock', 'owner.json'));
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const options = { scope: admissionScope, control, lock, admission };
    await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, scope: { ...admissionScope } }),
      { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, admission: { ...admission } }));
    await assert.rejects(captureWindowsInactiveTaskAdmission({
      ...options, lock: { ...lock, token: randomUUID() },
    }));
    try {
      await writeFile(path.join(control, 'state.json'), JSON.stringify({ ...state, priorRuntime: 'running' }));
      await assert.rejects(captureWindowsInactiveTaskAdmission(options), /original locked stopped preflight/);
      assert.ok(!(await readdir(control)).includes('task-maintenance'));
    } finally { await writeFile(path.join(control, 'state.json'), stateBytes); }
    assert.deepEqual(await admissionScope.check(), admissionScope.observation);
    assert.ok(!(await readdir(control)).includes('task-maintenance'));
    const published = await captureWindowsInactiveTaskAdmission(options);
    const bytes = await readFile(published.admission);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), published.sha256);
    assert.deepEqual(JSON.parse(bytes), createWindowsInactiveTaskAdmissionRecord({
      observation: admissionScope.observation, lock, state,
    }));
    assert.deepEqual(await readFile(path.join(control, 'state.json')), stateBytes);
    assert.deepEqual(await readFile(path.join(control, 'lock', 'owner.json')), lockBytes);
    assert.deepEqual(await admissionScope.check(), admissionScope.observation);
    const duplicateScope = await inspectWindowsInactiveTask({ taskName, project, pwsh });
    try {
      await assert.rejects(captureWindowsInactiveTaskAdmission({ ...options, scope: duplicateScope }),
        { code: 'DEPLOYMENT_WINDOWS_MANAGED_TASK_REFUSED' });
    } finally { await duplicateScope.close(); }
    const { beginWindowsInactiveTaskTransaction, assertWindowsInactiveTaskSnapshotStage } =
      await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
    const transactionOptions = { scope: admissionScope, control, lock, ...published };
    await assert.rejects(beginWindowsInactiveTaskTransaction(transactionOptions),
      /stopped-phase transaction/);
    const tools = {
      node: process.execPath, git: await realpath(gitFile), npmCli: await realpath(npmFile),
      environment: Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'ComSpec'].map(key => [key, process.env[key]])),
    };
    const { createWindowsSourceRepository } = await import('./deployment-windows-source-build.mjs');
    const { beforeCommit: sourceCommit, targetCommit, git } = await createWindowsSourceRepository({ project, tools });
    const stoppedState = {
      ...state, phase: 'stopped', previousPhase: 'preflight', sourceCommit, targetCommit,
    };
    await writeState(control, stoppedState);
    await assert.rejects(beginWindowsInactiveTaskTransaction({ ...transactionOptions, scope: { ...admissionScope } }));
    const transaction = await beginWindowsInactiveTaskTransaction(transactionOptions);
    let activatedRuntime;
    let completed = false;
    try {
      const snapshotOptions = { context: transaction, control, lock, sourceCommit };
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage(snapshotOptions), /copying/);
      await writeState(control, { ...stoppedState, phase: 'copying', previousPhase: 'stopped' });
      const metadata = await assertWindowsInactiveTaskSnapshotStage(snapshotOptions);
      assert.equal(metadata.project, project);
      assert.equal(metadata.sourceCommit, sourceCommit);
      assert.equal(metadata.task.name, taskName);
      assert.equal(Object.hasOwn(metadata.task, 'instanceGuid'), false);
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage({
        ...snapshotOptions, context: { ...transaction },
      }));
      await assert.rejects(assertWindowsInactiveTaskSnapshotStage({
        ...snapshotOptions, sourceCommit: 'c'.repeat(40),
      }));
      const { createWindowsInactiveTaskSnapshot } =
        await import(pathToFileURL(path.join(source, 'windows-task-snapshot.mjs')).href);
      assert.equal(typeof createWindowsInactiveTaskSnapshot, 'function', 'Missing inactive task snapshot integration');
      const { verifySnapshot } = await import(pathToFileURL(path.join(source, 'snapshot.mjs')).href);
      const { prepareWindowsConfigurationFixture } = await import('./deployment-windows-configuration.mjs');
      const configuration = await prepareWindowsConfigurationFixture({ scope: admissionScope, pwsh, inactive: true });
      const destination = path.join(control, 'staging');
      const copyOptions = {
        context: transaction, control, lock, pwsh, destination, id: 'inactive-task-snapshot',
        source: { commit: sourceCommit, provenance: 'observed' }, recoveryEngine: recovery.manifestSha256,
        configuration,
      };
      await assert.rejects(createWindowsInactiveTaskSnapshot({ ...copyOptions, context: { ...transaction } }));
      assert.ok(!(await readdir(control)).includes('staging'));
      const manifest = await createWindowsInactiveTaskSnapshot(copyOptions);
      assert.deepEqual(await verifySnapshot(destination), manifest);
      assert.deepEqual(manifest.runtime, { platform: 'win32', state: 'stopped', task: metadata.task });
      assert.equal(manifest.recoveryEngine, recovery.manifestSha256);
      assert.equal(manifest.source.commit, sourceCommit);
      assert.ok(manifest.windowsSecurity);
      console.log('PASS: inactive task transaction creates and verifies a real stopped snapshot with original task policy and saved recovery engine');
      await transaction.check();
      const { rotateWindowsInactiveTaskSnapshot } =
        await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
      assert.equal(typeof rotateWindowsInactiveTaskSnapshot, 'function', 'Missing inactive snapshot rotation');
      await assert.rejects(rotateWindowsInactiveTaskSnapshot({ context: transaction, control, lock }), /rotating/);
      const rotating = { ...stoppedState, phase: 'rotating', previousPhase: 'copying', backupId: manifest.id };
      await writeState(control, rotating);
      await transaction.check();
      await assert.rejects(rotateWindowsInactiveTaskSnapshot({ context: { ...transaction }, control, lock }));
      await rotateWindowsInactiveTaskSnapshot({ context: transaction, control, lock });
      assert.deepEqual(await verifySnapshot(path.join(control, 'backup')), manifest);
      assert.ok(!(await readdir(control)).includes('staging'));
      await writeState(control, { ...rotating, phase: 'backup-ready', previousPhase: 'rotating' });
      await transaction.check();
      console.log('PASS: inactive transaction rotates only its verified staged snapshot and retains the matching backup-ready binding');
      const { assertWindowsInactiveTaskSourceStage } =
        await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
      assert.equal(typeof assertWindowsInactiveTaskSourceStage, 'function', 'Missing inactive source stage authority');
      const sourceOptions = {
        context: transaction, control, lock, generation: stoppedState.runtimeIdentity, commit: stoppedState.targetCommit,
      };
      const { prepareWindowsInactiveSourceBuild } =
        await import(pathToFileURL(path.join(source, 'windows-source-build.mjs')).href);
      assert.equal(typeof prepareWindowsInactiveSourceBuild, 'function', 'Missing inactive owned source/build integration');
      const { saveWorkerEngine } = await import(pathToFileURL(path.join(source, 'saved-worker-engine.mjs')).href);
      const { createWorkerOperation } = await import(pathToFileURL(path.join(source, 'worker-operation.mjs')).href);
      const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
      const operation = await createWorkerOperation({ control, lock, saved });
      const options = { scope: admissionScope, control, lock, operation, pwsh, ...tools };
      await assert.rejects(prepareWindowsInactiveSourceBuild({ ...options, scope: { ...admissionScope } }));
      const stages = await prepareWindowsInactiveSourceBuild(options);
      assert.equal((await stages.inspect()).commit, sourceCommit);
      const target = await stages.resolve({ options: { revision: targetCommit } });
      assert.equal(target.commit, targetCommit);
      await assert.rejects(stages.select({ target, stopped: transaction }));
      assert.equal(await git(['rev-parse', 'HEAD']), sourceCommit);
      await assert.rejects(assertWindowsInactiveTaskSourceStage({ ...sourceOptions, stage: 'select' }), /source|stage/i);
      let previousPhase = 'backup-ready';
      for (const [stage, phase] of [['select', 'source-selected'], ['dependencies', 'dependencies'], ['build', 'building']]) {
        await writeState(control, { ...rotating, phase, previousPhase });
        await assertWindowsInactiveTaskSourceStage({ ...sourceOptions, stage });
        await assert.rejects(assertWindowsInactiveTaskSourceStage({
          ...sourceOptions, stage, context: { ...transaction },
        }));
        await assert.rejects(assertWindowsInactiveTaskSourceStage({ ...sourceOptions, stage, commit: sourceCommit }));
        if (stage === 'select') {
          await assert.rejects(stages.select({ target, stopped: { ...transaction } }));
          assert.equal((await stages.select({ target, stopped: transaction })).commit, targetCommit);
        } else {
          await assert.rejects(stages.npm({ stage, commit: sourceCommit, stopped: transaction }));
          const built = await stages.npm({
            stage, commit: targetCommit, stopped: transaction, environment: configuration.buildEnvironment(tools.environment),
          });
          if (stage === 'build') {
            assert.equal(built.sourceCommit, targetCommit);
            assert.equal(built.artifacts.identity.buildId, 'new-source');
            await built.artifacts.check();
          }
        }
        await configuration.checkFiles();
        previousPhase = phase;
      }
      await operation.seal();
      await configuration.close();
      assert.equal(await readFile(path.join(project, 'source-marker.txt'), 'utf8'), 'new-source\n');
      console.log('PASS: inactive transaction runs owned Git selection, npm dependencies and build for its exact admitted target');
      assert.deepEqual(await verifySnapshot(path.join(control, 'backup')), manifest);
      console.log('PASS: inactive source stages require original transaction, exact target and the retained verified backup');
      const { prepareWindowsInactiveTaskActivation } =
        await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
      assert.equal(typeof prepareWindowsInactiveTaskActivation, 'function', 'Missing native inactive activation preparation');
      const preparationOptions = { context: transaction, control, lock, bundle };
      await assert.rejects(prepareWindowsInactiveTaskActivation(preparationOptions), /activating/);
      await writeState(control, { ...rotating, phase: 'configuring', previousPhase: 'building' });
      await transaction.check();
      await writeState(control, { ...rotating, phase: 'activating', previousPhase: 'configuring' });
      await transaction.check();
      await assert.rejects(prepareWindowsInactiveTaskActivation({
        ...preparationOptions, context: { ...transaction },
      }));
      await assert.rejects(prepareWindowsInactiveTaskActivation({
        ...preparationOptions, bundle: { ...bundle, configuration: admissionScope.observation.configuration },
      }));
      const preparation = await prepareWindowsInactiveTaskActivation(preparationOptions);
      const preparationBytes = await readFile(preparation.file);
      assert.equal(createHash('sha256').update(preparationBytes).digest('hex'), preparation.sha256);
      const intent = JSON.parse(preparationBytes);
      assert.equal(intent.kind, 'inactive');
      assert.equal(intent.phase, 'activation-prepared');
      assert.equal(intent.admissionSha256, published.sha256);
      assert.equal(intent.stateSha256,
        createHash('sha256').update(await readFile(path.join(control, 'state.json'))).digest('hex'));
      assert.equal(intent.configuration, bundle.configuration);
      assert.equal(intent.configurationSha256, bundle.sha256);
      assert.equal(Object.hasOwn(intent, 'instanceGuid'), false);
      await assert.rejects(prepareWindowsInactiveTaskActivation(preparationOptions));
      assert.deepEqual(await admissionScope.check(), admissionScope.observation);
      assert.deepEqual(await readFile(preparation.file), preparationBytes);
      console.log('PASS: native inactive activation preparation retains exact stopped admission, activating state and distinct runtime bundle without starting or replacing the task');
      const { replaceWindowsInactiveTask } =
        await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
      assert.equal(typeof replaceWindowsInactiveTask, 'function', 'Missing native inactive task replacement');
      const replacementOptions = { context: transaction, control, lock };
      await assert.rejects(replaceWindowsInactiveTask({ ...replacementOptions, context: { ...transaction } }));
      const replacement = await replaceWindowsInactiveTask(replacementOptions);
      assert.equal(replacement.replaced, true);
      assert.equal(replacement.inhibited, true);
      assert.notEqual(replacement.definition, admissionScope.observation.definition);
      const replacementBytes = await readFile(replacement.file);
      assert.equal(createHash('sha256').update(replacementBytes).digest('hex'), replacement.sha256);
      const replaced = JSON.parse(replacementBytes);
      assert.equal(replaced.phase, 'replacement-complete');
      assert.equal(replaced.preparationSha256, preparation.sha256);
      assert.equal(replaced.configuration, bundle.configuration);
      assert.equal(replaced.definition, replacement.definition);
      await assert.rejects(replaceWindowsInactiveTask(replacementOptions));
      await transaction.check();
      assert.deepEqual(await verifySnapshot(path.join(control, 'backup')), manifest);
      console.log('PASS: native inactive replacement changes only the literal runtime action, preserves disabled policy and security, and retains original preparation evidence');
      const { startWindowsInactiveTask } =
        await import(pathToFileURL(path.join(source, 'windows-inactive-task-transaction.mjs')).href);
      assert.equal(typeof startWindowsInactiveTask, 'function', 'Missing native inactive guarded startup');
      await assert.rejects(startWindowsInactiveTask({ ...replacementOptions, context: { ...transaction } }));
      const previousListener = JSON.parse(await readFile(path.join(project, 'listener.json'), 'utf8'));
      const active = await startWindowsInactiveTask(replacementOptions);
      assert.equal(active.status, 'guarded-running');
      assert.equal(active.taskName, taskName);
      activatedRuntime = active.runtime;
      assert.notEqual(active.runtime.identity, admissionScope.observation.retiredRuntime.identity);
      assert.notEqual(active.runtime.generation, admissionScope.observation.retiredRuntime.generation);
      assert.match(active.runtime.instanceGuid, /^[a-f0-9-]{36}$/);
      assert.equal(active.runtime.configurationSha256, bundle.sha256);
      await transaction.check();
      await assert.rejects(startWindowsInactiveTask(replacementOptions));
      console.log('PASS: native inactive guarded startup binds a distinct actual Scheduler owner, readiness and owned Job without inventing a prior instance');
      assert.equal(typeof transaction.listener, 'function', 'Missing inactive owned listener authority');
      await assert.rejects(transaction.listener({ port: 0 }));
      let listener;
      const listenerDeadline = Date.now() + 30000;
      do {
        listener = JSON.parse(await readFile(path.join(project, 'listener.json'), 'utf8'));
        if (listener.pid !== previousListener.pid) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < listenerDeadline);
      assert.notEqual(listener.pid, previousListener.pid);
      await writeFile(path.join(project, 'health-mode'), 'ready');
      const { waitWindowsReadiness } = await import(pathToFileURL(path.join(source, 'windows-readiness.mjs')).href);
      const ready = await waitWindowsReadiness({
        context: transaction, port: listener.port, providers: ['admin-login'], waitSeconds: 30,
      });
      assert.equal(ready.status, 'ready');
      assert.equal(ready.generation, active.runtime.generation);
      const owned = await transaction.listener({ port: listener.port });
      assert.equal(owned.pid, listener.pid);
      assert.equal(owned.generation, active.runtime.generation);
      console.log('PASS: inactive startup readiness verifies HTTP providers only through its retained original Job listener');
      if (['complete', 'recover'].includes(completionMode)) {
        assert.equal(typeof transaction.prepareCompletion, 'function', 'Missing inactive native completion preparation');
        assert.equal(typeof transaction.complete, 'function', 'Missing inactive native completion');
        assert.equal(typeof transaction.advanceCompletion, 'function', 'Missing inactive native completion step API');
        await assert.rejects(transaction.prepareCompletion({ port: listener.port, providers: [] }));
        await assert.rejects(transaction.complete({ stateSha256: '0'.repeat(64) }));
        const { completeWindowsTaskActivation } =
          await import(pathToFileURL(path.join(source, 'windows-task-completion.mjs')).href);
        const result = await completeWindowsTaskActivation({
          context: {
            ...transaction,
            async complete(options) {
              const expected = new Set(['inactive-complete-prepared.json']);
              for (const [step, durable] of [
                ['policy-requested', 'policy-requested'],
                ['policy-applied', 'policy-requested'],
                ['policy-staged', 'policy-staged'],
                ['release-requested', 'release-requested'],
                ['lease-released', 'release-requested'],
                ['released', 'released'],
                ['policy-restore-requested', 'policy-restore-requested'],
                ['permanent-policy-applied', 'policy-restore-requested'],
                ['complete', 'complete'],
              ]) {
                assert.equal(await transaction.advanceCompletion(options), step);
                expected.add(`inactive-complete-${durable}.json`);
                assert.deepEqual((await readdir(path.join(control, 'task-maintenance')))
                  .filter(name => name.startsWith('inactive-complete-')).sort(), [...expected].sort());
                await transaction.check();
                if (completionMode === 'recover' && step === 'lease-released') {
                  const running = JSON.parse(await readFile(
                    path.join(control, 'task-maintenance/inactive-start-running.json'), 'utf8'));
                  console.log('INACTIVE_COMPLETION_HELD ' + JSON.stringify({
                    step, bridge: { pid: running.controllerPid, identity: running.controllerIdentity },
                  }));
                  await new Promise(() => { setInterval(() => {}, 1000); });
                }
                if (step === 'policy-requested') {
                  for (const method of ['complete', 'advanceCompletion']) {
                    await assert.rejects(transaction[method]({ stateSha256: '0'.repeat(64) }));
                  }
                }
              }
              assert.equal(await transaction.advanceCompletion(options), 'complete');
              return transaction.complete(options);
            },
          }, port: listener.port, providers: ['admin-login'], waitSeconds: 30,
          async recordAcceptance() {
            await writeState(control, {
              ...rotating, phase: 'accepted', previousPhase: 'activating', updatedAt: new Date().toISOString(),
            });
            return createHash('sha256').update(await readFile(path.join(control, 'state.json'))).digest('hex');
          },
        });
        assert.equal(result.status, 'completed');
        assert.equal((await transaction.check()).phase, 'accepted');
        completed = true;
        console.log('PASS: inactive completion binds accepted terminal state, permanent policy and original guarded lease release');
      }
    } finally { await transaction.close(); }
    if (activatedRuntime) {
      const { processIdentity } = await import(pathToFileURL(path.join(source, 'process-identity.mjs')).href);
      if (completed) {
        assert.equal(await processIdentity(activatedRuntime.pid), activatedRuntime.identity);
      } else {
        const deadline = Date.now() + 30000;
        while (await processIdentity(activatedRuntime.pid) === activatedRuntime.identity && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.notEqual(await processIdentity(activatedRuntime.pid), activatedRuntime.identity);
        console.log('PASS: inactive startup guard settles its actual runtime after the original native controller closes');
      }
    }
    await assert.rejects(transaction.check(), /closed/);
    console.log('PASS: inactive transaction consumes original stopped admission and grants only matching copying-stage snapshot metadata');
    assert.deepEqual(await readFile(published.admission), bytes);
  });
} finally {
  await admissionScope.close();
}
await assert.rejects(releaseLock(control, lock, { pwsh }), /maintenance evidence requires explicit runtime recovery/);
assert.deepEqual(JSON.parse(await readFile(path.join(control, 'lock', 'owner.json'))), lock);
console.log('PASS: native inactive admission binds actual stopped lock and state, rejects forged scope and preserves create-only evidence');
