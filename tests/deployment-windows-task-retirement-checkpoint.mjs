import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import {
  openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
  prepareWindowsTaskRetirementCheckpoint,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh] = process.argv.slice(2);
await withWindowsAdmission(control, { pwsh }, async admission => {
  const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
  try {
    const intent = await prepareWindowsTaskRetirement(control, proof, admission);
    const result = await prepareWindowsTaskRetirementCheckpoint(control, proof, admission);
    assert.equal(result.status, 'prepared');
    assert.equal(result.descriptor.path, 'task-retirement-checkpoint.json');
    assert.deepEqual(result.intent, intent);
    assert.deepEqual(result.checkpoint.intent, intent.descriptor);
    const bytes = await readFile(path.join(control, result.descriptor.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.descriptor.sha256);
    assert.deepEqual(JSON.parse(bytes), result.checkpoint);
    assert.deepEqual(await prepareWindowsTaskRetirementCheckpoint(control, proof, admission), result);
    await proof.check();
  } finally { await proof.close(); }
});
console.log('PASS: private runtime checkpoint binds original retirement intent without deleting evidence');
