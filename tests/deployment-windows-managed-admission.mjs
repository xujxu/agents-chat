import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeState } from '../scripts/deployment/state.mjs';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';

export async function captureManagedAdmission({ taskName, project, pwsh, control, lock, makeState }) {
  const api = await import('../scripts/deployment/windows-managed-task.mjs');
  const scope = await api.inspectWindowsManagedTask({ taskName, project, pwsh });
  try {
    assert.equal(scope.observation.lease, 'unguarded');
    assert.equal(typeof api.captureWindowsManagedTaskAdmission, 'function',
      'Missing production managed-task admission capture');
    const capture = api.captureWindowsManagedTaskAdmission;
    const state = makeState(scope.observation.runtime.generation);
    await writeState(control, state);
    const result = await withWindowsAdmission(control, { pwsh }, async admission => {
      const options = { scope, control, lock, admission };
      await assert.rejects(capture({ ...options, scope: { ...scope } }));
      await assert.rejects(capture({ ...options, admission: { ...admission } }));
      await assert.rejects(capture({ ...options, lock: { ...lock, token: randomUUID() } }));
      await writeState(control, { ...state, runtimeIdentity: randomUUID() });
      await assert.rejects(capture(options));
      assert.ok(!(await readdir(control)).includes('task-maintenance'));
      await writeState(control, state);
      assert.deepEqual(await scope.check(), scope.observation);
      const captured = await capture(options);
      assert.equal(captured.admission, path.join(control, 'task-maintenance', 'admission.json'));
      assert.match(captured.sha256, /^[a-f0-9]{64}$/);
      const bytes = await readFile(captured.admission);
      await assert.rejects(capture(options));
      assert.deepEqual(await readFile(captured.admission), bytes);
      assert.deepEqual(JSON.parse(await readFile(path.join(control, 'state.json'), 'utf8')), state);
      return captured;
    });
    return { admission: result, state };
  } finally { await scope.close(); }
}
