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

export async function prepareWindowsFirstSavedCloseoutCase({ fixture, state }) {
  const { control, project, operationId, pwsh } = fixture;
  const receipt = await readFile(path.join(control, 'deployment.json'));
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
      assert.deepEqual(await readFile(path.join(control, 'deployment.json')), receipt);
      assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
      assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: saved.manifestSha256 }), saved);
      const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
      await releaseLock(control, next, { pwsh });
    },
    async close() {},
  };
}
