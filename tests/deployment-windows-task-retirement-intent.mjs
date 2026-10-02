import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { withWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import {
  openWindowsTaskCompletionProof, prepareWindowsTaskRetirement,
} from '../scripts/deployment/windows-task-completion-proof.mjs';

const [control, pwsh] = process.argv.slice(2);
await withWindowsAdmission(control, { pwsh }, async admission => {
  const proof = await openWindowsTaskCompletionProof({ control, pwsh, admission });
  try {
    await assert.rejects(prepareWindowsTaskRetirement(control, { ...proof }, admission),
      /Original retained completed-task proof/);
    const prepared = await prepareWindowsTaskRetirement(control, proof, admission);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.descriptor.path, 'task-retirement.json');
    assert.deepEqual(prepared.intent.completion, proof.observation);
    const bytes = await readFile(path.join(control, prepared.descriptor.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), prepared.descriptor.sha256);
    assert.deepEqual(JSON.parse(bytes), prepared.intent);
    for (const entry of [prepared.intent.lockFile, prepared.intent.state, ...prepared.intent.files]) {
      const info = await stat(path.join(control, entry.path), { bigint: true });
      assert.equal(String(info.dev), entry.dev);
      assert.equal(String(info.ino), entry.ino);
      assert.equal(Number(info.size), entry.bytes);
    }
    assert.deepEqual(await prepareWindowsTaskRetirement(control, proof, admission), prepared);
    await proof.check();
  } finally { await proof.close(); }
});
console.log('PASS: native task retirement intent binds original private evidence without deletion or unlock');
