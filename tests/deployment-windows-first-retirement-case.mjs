import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock, releaseLock } from '../scripts/deployment/state.mjs';

const implementation = new URL('../scripts/deployment/windows-first-deployment-retirement.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareWindowsFirstRetirementCase({ fixture, active, state }) {
  assert.ok(existsSync(implementation), 'Missing first-specific deployment retirement');
  const { openWindowsFirstDeploymentRetirement: open } = await import(implementation);
  const { control, pwsh, project, operationId } = fixture;
  const directory = path.join(control, `first-task-${operationId}`);
  const receiptFile = path.join(control, 'deployment.json');
  const receipt = await readFile(receiptFile);
  const journals = (await readdir(control)).filter(name => /^worker-[a-f0-9-]+\.ndjson$/.test(name));
  const totalEntries = (await readdir(directory)).length + journals.length
    + (await readdir(path.join(control, 'worker-engine'))).length + 5;
  const admission = await acquireWindowsAdmission({ control, pwsh });
  const options = { control, pwsh, admission };
  const refused = error => error.code === 'DEPLOYMENT_WINDOWS_FIRST_RETIREMENT_REFUSED';
  const rejectOpen = async predicate => {
    let unexpected;
    try { await assert.rejects(async () => { unexpected = await open(options); }, predicate); }
    finally { if (unexpected) await unexpected.close(); }
  };
  try {
    await rejectOpen(error => refused(error) && error.diagnostic?.includes('original-processes'));
    return {
      async verify() {
        let scope = await open(options);
        try {
          const initial = scope.observation;
          assert.equal(initial.status, 'retiring');
          assert.equal(initial.operationId, operationId);
          assert.equal(initial.stateSha256, hash(state));
          assert.equal(initial.receiptSha256, hash(receipt));
          assert.deepEqual(initial.runtime, active.runtime);
          assert.equal(initial.retiredEntries, 0);
          assert.equal(initial.totalEntries, totalEntries);
          assert.match(initial.manifestSha256, /^[a-f0-9]{64}$/);
          await rejectOpen(refused);
          await assert.rejects(writeFile(receiptFile, receipt));
          for (let index = 1; index <= totalEntries + 1; index++) {
            const observed = await scope.advance();
            assert.deepEqual(observed, {
              ...initial, status: index > totalEntries ? 'retired' : 'retiring',
              retiredEntries: Math.min(index, totalEntries),
            });
            if (index === 1 || index === totalEntries - 1) {
              await scope.close();
              if (index === 1) {
                const original = path.join(directory, 'completion-complete.json');
                const moved = path.join(path.dirname(control), 'held-first-completion.json');
                await rename(original, moved);
                try { await rejectOpen(refused); }
                finally { await rename(moved, original); }
              }
              scope = await open(options);
              assert.deepEqual(await scope.check(), observed);
            }
          }
        } finally { await scope.close(); }
        const remaining = await readdir(control);
        assert.equal(remaining.includes('lock'), false);
        assert.equal(remaining.some(name => name.startsWith('worker-') || name.startsWith('first-task-')), false);
        assert.deepEqual(await readFile(receiptFile), receipt);
        assert.deepEqual(await readFile(path.join(control, 'state.json')), state);
        assert.ok(remaining.includes(`first-runtime-${operationId}`));
        await admission.close();
        const next = await acquireLock(control, { project, operationId: randomUUID(), pwsh });
        await releaseLock(control, next, { pwsh });
      },
      close: () => admission.close(),
    };
  } catch (error) {
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First retirement fixture admission cleanup failed.'); }
    throw error;
  }
}
