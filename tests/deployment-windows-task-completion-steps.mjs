import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { waitWindowsReadiness } from '../scripts/deployment/windows-readiness.mjs';

export async function runWindowsTaskCompletionSteps({ context, control, port, providers, recordAcceptance, stopAfter }) {
  assert.equal(typeof context.advanceCompletion, 'function', 'Missing native completion step API: advanceCompletion');
  await waitWindowsReadiness({ context, port, providers });
  await context.prepareCompletion({ port, providers });
  const stateSha256 = await recordAcceptance();
  const steps = [
    ['policy-requested', 'policy-requested'],
    ['policy-applied', 'policy-requested'],
    ['policy-staged', 'policy-staged'],
    ['release-requested', 'release-requested'],
    ['lease-released', 'release-requested'],
    ['released', 'released'],
    ['policy-restore-requested', 'policy-restore-requested'],
    ['permanent-policy-applied', 'policy-restore-requested'],
    ['policy-restored', 'policy-restored'],
    ['enable-requested', 'enable-requested'],
    ['enable-applied', 'enable-requested'],
    ['complete', 'complete'],
  ];
  const expected = new Set(['task-complete-prepared.json']);
  const receipts = async () => (await readdir(path.join(control, 'task-maintenance')))
    .filter(name => name.startsWith('task-complete-')).sort();
  for (const [step, durable] of steps) {
    assert.equal(await context.advanceCompletion({ stateSha256 }), step);
    if (step === 'policy-requested') {
      for (const method of ['complete', 'advanceCompletion']) {
        await assert.rejects(context[method]({ stateSha256: '0'.repeat(64) }),
          error => /original completion digest/i.test(error.cause?.message ?? ''));
      }
    }
    if (step === 'policy-applied') await context.prepareCompletion({ port, providers });
    await context.check();
    expected.add(`task-complete-${durable}.json`);
    assert.deepEqual(await receipts(), [...expected].sort());
    if (step === stopAfter) return Object.freeze({ status: 'interrupted', step, stateSha256 });
  }
  assert.equal(expected.size, 9);
  assert.equal(await context.advanceCompletion({ stateSha256 }), 'complete');
  await context.complete({ stateSha256 });
  assert.deepEqual(await receipts(), [...expected].sort());
  return Object.freeze({ status: 'completed', stateSha256 });
}
