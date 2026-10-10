import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { windowsTaskCompletionSteps } from '../scripts/deployment/windows-task-controller.mjs';

const implementation = new URL('../scripts/deployment/windows-first-completion-recovery.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const phaseFor = step => ({
  'lease-released': 'release-requested', 'permanent-policy-applied': 'policy-restore-requested',
  'enable-applied': 'enable-requested',
})[step] ?? step;

export async function prepareWindowsFirstRecoveryCase({ fixture, active, step, port, release, state }) {
  assert.ok(existsSync(implementation), 'Missing first-runtime cold completion recovery');
  const { openWindowsFirstCompletionRecovery: open } = await import(implementation);
  const admission = await acquireWindowsAdmission({ control: fixture.control, pwsh: fixture.pwsh });
  const options = { control: fixture.control, pwsh: fixture.pwsh, admission };
  const rejectOpen = async predicate => {
    let unexpected;
    try { await assert.rejects(async () => { unexpected = await open(options); }, predicate); }
    finally { if (unexpected) await unexpected.close(); }
  };
  const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_COMPLETION_RECOVERY_REFUSED';
  try {
    await rejectOpen(error => refused(error) && error.diagnostic?.includes('original-processes'));
    const verify = (value, expectedStep) => {
      assert.equal(value.status, expectedStep === 'complete' ? 'complete' : 'pending');
      assert.equal(value.step, expectedStep);
      assert.equal(value.phase, phaseFor(expectedStep));
      assert.equal(value.operationId, fixture.operationId);
      assert.equal(value.taskName, fixture.taskName);
      assert.equal(value.stateSha256, hash(state));
      assert.equal(value.lease, 'released');
      assert.deepEqual(value.runtime, active.runtime);
      assert.equal(value.port, port);
      assert.deepEqual(value.providers, ['admin-login']);
    };
    return {
      async verify() {
        let recovery = await open(options);
        try {
          verify(recovery.observation, step);
          await rejectOpen(refused);
          for (const next of windowsTaskCompletionSteps.slice(windowsTaskCompletionSteps.indexOf(step) + 1)) {
            verify(await recovery.advance(), next);
            verify(await recovery.check(), next);
            if (next === 'policy-restored') {
              const snapshot = recovery.observation;
              await recovery.close();
              recovery = await open(options);
              assert.deepEqual(recovery.observation, snapshot);
            }
          }
          const completed = recovery.observation;
          verify(completed, 'complete');
          assert.deepEqual(await recovery.advance(), completed);
          await recovery.close();
          recovery = await open(options);
          assert.deepEqual(recovery.observation, completed);
          const directory = path.join(fixture.control, `first-task-${fixture.operationId}`);
          let previous = hash(release);
          for (const phase of ['released', 'policy-restore-requested', 'policy-restored', 'enable-requested', 'complete']) {
            const bytes = await readFile(path.join(directory, `completion-${phase}.json`));
            const record = JSON.parse(bytes);
            assert.equal(record.phase, phase);
            assert.equal(record.previousSha256, previous);
            assert.deepEqual(record.runtime, active.runtime);
            assert.equal(record.controllerPid, active.controllerPid);
            assert.equal(record.controllerIdentity, active.controllerIdentity);
            assert.equal(record.enabled, phase === 'complete');
            assert.equal(record.lease, 'released');
            assert.equal(record.status, phase === 'complete' ? 'first-runtime-completed' : 'first-completion-progress');
            previous = hash(bytes);
          }
          assert.equal(completed.completionSha256, previous);
        } finally { await recovery.close(); }
      },
      close: () => admission.close(),
    };
  } catch (error) {
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First-recovery fixture admission cleanup failed.'); }
    throw error;
  }
}
