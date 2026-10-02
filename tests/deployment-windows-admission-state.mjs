import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from '../scripts/deployment/windows-admission.mjs';
import { acquireLock, releaseLock, reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { recoverRetirement } from '../scripts/deployment/retirement-recovery.mjs';

const [control, project, pwsh] = process.argv.slice(2);
const options = () => ({ project, operationId: randomUUID(), pwsh });
const busy = error => error.code === 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED'
  && /acquire\/busy/.test(error.diagnostic);
let admission;
let primary;
try {
  assert.deepEqual(await readdir(control), []);
  assert.equal((await reconcileInterruptedOperation(control)).status, 'idle');
  assert.deepEqual(await readdir(control), []);
  admission = await acquireWindowsAdmission({ control, pwsh });
  const initial = await readdir(control);
  assert.equal((await reconcileInterruptedOperation(control)).status, 'idle');
  await assert.rejects(acquireLock(control, options()), busy,
    'Normal Windows lock acquisition bypassed active native admission');
  assert.deepEqual(await readdir(control), initial);
  await assert.rejects(recoverRetirement({ control, ...options() }), busy,
    'Windows cold recovery bypassed active native admission');
  assert.deepEqual(await readdir(control), initial);
  await admission.close();
  admission = undefined;

  const lock = await acquireLock(control, options());
  const ownerPath = path.join(control, 'lock', 'owner.json');
  const ownerBytes = await readFile(ownerPath);
  admission = await acquireWindowsAdmission({ control, pwsh });
  await assert.rejects(releaseLock(control, lock, { pwsh }), busy,
    'Windows lock release bypassed active native admission');
  assert.deepEqual(await readFile(ownerPath), ownerBytes);
  await releaseLock(control, lock, { admission });
  assert.deepEqual(await readdir(control), ['windows-admission.lock']);

  const nested = await acquireLock(control, { ...options(), admission });
  await releaseLock(control, nested, { admission });
  await assert.rejects(acquireLock(project, { ...options(), admission }), /retained Windows admission/);
  await assert.rejects(acquireLock(control, {
    ...options(), admission: { check() { assert.fail('Forged admission must not execute'); } },
  }), /retained Windows admission/);
  assert.deepEqual(await readdir(project), []);
  await admission.close();
  admission = undefined;
  await assert.rejects(acquireLock(control, { project, operationId: randomUUID() }),
    error => error.code === 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED');
  assert.deepEqual(await readdir(control), ['windows-admission.lock']);
  console.log('PASS: Windows acquire/release/recovery share actual native admission; retained contexts avoid reentry and read-only inspection remains read-only');
} catch (error) {
  primary = error;
  throw error;
} finally {
  if (admission) {
    try { await admission.close(); }
    catch (error) {
      throw new AggregateError([...(primary ? [primary] : []), error], 'Ownership fixture admission cleanup failed.');
    }
  }
}
