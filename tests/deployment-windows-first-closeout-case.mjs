import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';
import {
  saveRecoveryEngine, verifyRecoveryEngine, retirementRecoveryInvocation,
} from '../scripts/deployment/saved-recovery-engine.mjs';

export async function prepareWindowsFirstSavedCloseoutCase({ fixture, state, missingReceipt = false }) {
  const { control, project, operationId, pwsh } = fixture;
  const receiptFile = path.join(control, 'deployment.json');
  let receipt;
  let originalIdentity;
  if (missingReceipt) {
    await assert.rejects(readFile(receiptFile), { code: 'ENOENT' });
    originalIdentity = JSON.parse(await readFile(path.join(control,
      `first-task-${operationId}`, 'completion-prepared.json'))).deploymentIdentity;
    assert.ok(originalIdentity, 'Saved cold closeout requires original prepared identity.');
  } else { receipt = await readFile(receiptFile); }
  const saved = await saveRecoveryEngine({
    control, source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
  });
  const command = retirementRecoveryInvocation(saved, { control, project, operationId, pwsh, kind: 'task' });
  return {
    async verify() {
      const result = await promisify(execFile)(command.file, command.args, {
        cwd: path.dirname(project), env: command.env, timeout: 300000, maxBuffer: 32768,
      });
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { status: 'completed', operationId, phase: 'accepted' });
      const remaining = await readdir(control);
      assert.equal(remaining.includes('lock'), false);
      assert.equal(remaining.some(name => name.startsWith('worker-') || name.startsWith('first-task-')), false);
      assert.ok(remaining.includes(`first-runtime-${operationId}`));
      const published = await readFile(receiptFile);
      if (missingReceipt) {
        const recovered = JSON.parse(published);
        assert.deepEqual(recovered, {
          version: 1, project, operationId, status: 'accepted', acceptedAt: JSON.parse(state).updatedAt,
          identity: { ...originalIdentity, service: recovered.identity.service },
        });
        assert.match(recovered.identity.service, /^[a-f0-9]{64}$/);
      } else { assert.deepEqual(published, receipt); }
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: saved.manifestSha256 }), saved);
      const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
      await releaseLock(control, next, { pwsh });
    },
    async close() {},
  };
}
