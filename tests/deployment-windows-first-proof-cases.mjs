import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';

const implementation = new URL('../scripts/deployment/windows-first-completion-proof.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_COMPLETION_PROOF_REFUSED';

export async function prepareWindowsFirstProofCase({ fixture, active, port, release, state, completed = false }) {
  assert.ok(existsSync(implementation), 'Missing first-runtime cold completion proof');
  const api = await import(implementation);
  const stateFile = path.join(fixture.control, 'state.json');
  const releaseFile = path.join(fixture.control, `first-task-${fixture.operationId}`, 'completion-release-requested.json');
  const completion = completed
    ? await readFile(path.join(path.dirname(releaseFile), 'completion-complete.json')) : release;
  const receiptFile = path.join(fixture.control, 'deployment.json');
  const receipt = completed ? await readFile(receiptFile) : null;
  const admission = await acquireWindowsAdmission({ control: fixture.control, pwsh: fixture.pwsh });
  const options = { control: fixture.control, pwsh: fixture.pwsh, admission };
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
      status: 'first-completion-observed', mutationAuthority: false, phase: completed ? 'complete' : 'release-requested',
      operationId: fixture.operationId, taskName: fixture.taskName,
      stateSha256: hash(state), completionSha256: hash(completion),
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
          if (receipt) await assert.rejects(writeFile(receiptFile, receipt));
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
        for (const name of [...(completed ? [] : ['completion-complete.json']), 'activation-stopped.json']) {
          const file = path.join(path.dirname(releaseFile), name);
          await assert.rejects(readFile(file), { code: 'ENOENT' });
          try {
            await writeFile(file, release);
            await rejectProof(options, refused);
          } finally { await rm(file, { force: true }); }
        }
        for (const name of ['.deployment.json.staging', ...(completed ? [] : ['deployment.json'])]) {
          const file = path.join(fixture.control, name);
          await assert.rejects(readFile(file), { code: 'ENOENT' });
          try {
            await writeFile(file, receipt ?? '{}');
            await rejectProof(options, refused);
          } finally { await rm(file, { force: true }); }
        }
        if (receipt) {
          for (const mutation of [
            value => { value.operationId = '00000000-0000-0000-0000-000000000000'; },
            value => { value.project += '-foreign'; },
            value => { value.acceptedAt = '2000-01-01T00:00:00.000Z'; },
            value => { value.identity.source = '0'.repeat(40); },
            value => { value.identity.build = 'invalid'; },
            value => { value.status = 'pending'; },
            value => { value.unrecognized = true; },
          ]) {
            const changed = JSON.parse(receipt);
            mutation(changed);
            try {
              await writeFile(receiptFile, JSON.stringify(changed));
              await rejectProof(options, refused);
            } finally { await writeFile(receiptFile, receipt); }
          }
        }
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
