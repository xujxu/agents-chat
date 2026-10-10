import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';

const implementation = new URL('../scripts/deployment/windows-first-completion-proof.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_COMPLETION_PROOF_REFUSED';

export async function prepareWindowsFirstProofCase({ fixture, active, port, release, state }) {
  assert.ok(existsSync(implementation), 'Missing first-runtime cold completion proof');
  const api = await import(implementation);
  const admission = await acquireWindowsAdmission({ control: fixture.control, pwsh: fixture.pwsh });
  const options = { control: fixture.control, pwsh: fixture.pwsh, admission };
  const stateFile = path.join(fixture.control, 'state.json');
  const releaseFile = path.join(fixture.control, `first-task-${fixture.operationId}`, 'completion-release-requested.json');
  const rejectProof = async (supplied, predicate) => {
    let unexpected;
    try {
      await assert.rejects(async () => { unexpected = await api.openWindowsFirstCompletionProof(supplied); }, predicate);
    } finally { if (unexpected) await unexpected.close(); }
  };
  try {
    await rejectProof({ ...options, admission: { ...admission } });
    await rejectProof(options,
      error => refused(error) && error.diagnostic?.includes('original-processes'));
    const expected = {
      status: 'first-completion-observed', mutationAuthority: false, phase: 'release-requested',
      operationId: fixture.operationId, taskName: fixture.taskName,
      stateSha256: hash(state), completionSha256: hash(release),
      runtime: active.runtime, port, providers: ['admin-login'], lease: 'released',
    };
    return {
      async verify() {
        const proof = await api.openWindowsFirstCompletionProof(options);
        try {
          assert.deepEqual(proof.observation, expected);
          assert.deepEqual(await api.assertWindowsFirstCompletionProof(fixture.control, proof, admission), expected);
          await assert.rejects(api.assertWindowsFirstCompletionProof(fixture.control, { ...proof }, admission));
          await assert.rejects(writeFile(stateFile, state));
        } finally { await proof.close(); }
        await assert.rejects(proof.check());
        for (const mutation of [
          value => { value.lease = 'released'; },
          value => { value.runtime.launcherPid += 1; },
          value => { value.previousSha256 = '0'.repeat(64); },
          value => { value.providers = ['github']; },
        ]) {
          const changed = JSON.parse(release);
          mutation(changed);
          try {
            await writeFile(releaseFile, JSON.stringify(changed));
            await rejectProof(options, refused);
          } finally { await writeFile(releaseFile, release); }
        }
        try {
          await writeFile(stateFile, JSON.stringify({ ...JSON.parse(state), targetCommit: '0'.repeat(40) }));
          await rejectProof(options, refused);
        } finally { await writeFile(stateFile, state); }
        const reopened = await api.openWindowsFirstCompletionProof(options);
        try { assert.deepEqual(await reopened.check(), expected); }
        finally { await reopened.close(); }
      },
      close: () => admission.close(),
    };
  } catch (error) {
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First-proof fixture admission cleanup failed.'); }
    throw error;
  }
}
