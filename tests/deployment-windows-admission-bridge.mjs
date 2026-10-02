import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const [mode, control, other, pwsh] = process.argv.slice(2);
const { acquireWindowsAdmission, assertWindowsAdmission } =
  await import('../scripts/deployment/windows-admission.mjs');
assert.equal(process.platform, 'win32');

async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 30000);
    })]);
  } finally { clearTimeout(timer); }
}

async function requireBridgeExit(identity) {
  const deadline = Date.now() + 15000;
  while (await processIdentity(identity.pid) === identity.processIdentity) {
    assert.ok(Date.now() < deadline, 'Original native admission bridge survived controller exit');
    await delay(250);
  }
}

if (mode === 'hold') {
  const lease = await acquireWindowsAdmission({ control, pwsh });
  await assertWindowsAdmission(control, lease);
  process.send({ type: 'held', identity: lease.identity });
  await new Promise(() => {});
} else {
  assert.equal(mode, 'suite');
  let lease;
  let independent;
  let owner;
  let ownerExit;
  let bridgeIdentity;
  let primary;
  const isRefusal = error => error.code === 'DEPLOYMENT_WINDOWS_ADMISSION_REFUSED';
  try {
    lease = await acquireWindowsAdmission({ control, pwsh });
    await assertWindowsAdmission(control, lease);
    await assert.rejects(acquireWindowsAdmission({ control, pwsh }),
      error => isRefusal(error) && /acquire\/busy/.test(error.diagnostic));
    independent = await acquireWindowsAdmission({ control: other, pwsh });
    await assertWindowsAdmission(other, independent);
    await independent.close();
    independent = undefined;
    await assert.rejects(assertWindowsAdmission(other, lease), /retained Windows admission/);
    await assert.rejects(assertWindowsAdmission(control, {
      check() { assert.fail('Forged context callback must not execute'); },
    }), /retained Windows admission/);
    await assertWindowsAdmission(control, lease);
    const identity = lease.identity;
    await lease.close();
    await lease.close();
    await assert.rejects(assertWindowsAdmission(control, lease), isRefusal);
    await requireBridgeExit(identity);
    lease = undefined;
    console.log('PASS: original native bridge excludes competitors, separates controls and refuses foreign/forged/closed admission');

    owner = fork(fileURLToPath(import.meta.url), ['hold', control, other, pwsh], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
    });
    ownerExit = new Promise((resolve, reject) => {
      owner.once('exit', (code, signal) => resolve({ code, signal }));
      owner.once('error', reject);
    });
    ownerExit.catch(() => {});
    const ready = await bounded(new Promise((resolve, reject) => {
      owner.once('message', resolve);
      owner.once('error', reject);
      owner.once('exit', () => reject(new Error('Fixture controller exited before admission')));
    }), 'Fixture controller did not acquire admission');
    assert.equal(ready.type, 'held');
    bridgeIdentity = ready.identity;
    assert.equal(await processIdentity(bridgeIdentity.pid), bridgeIdentity.processIdentity);
    await assert.rejects(acquireWindowsAdmission({ control, pwsh }),
      error => isRefusal(error) && /acquire\/busy/.test(error.diagnostic));
    assert.ok(owner.kill(), 'Original fixture controller could not be terminated');
    await bounded(ownerExit, 'Original fixture controller did not exit');
    await requireBridgeExit(bridgeIdentity);
    lease = await acquireWindowsAdmission({ control, pwsh });
    await assertWindowsAdmission(control, lease);
    await lease.close();
    lease = undefined;
    console.log('PASS: native admission follows original Node controller exit and permits a fresh acquisition');
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const errors = [];
    for (const retained of [lease, independent]) {
      if (retained) {
        try { await retained.close(); } catch (error) { errors.push(error); }
      }
    }
    if (owner) {
      try {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill();
        await bounded(ownerExit, 'Fixture controller cleanup did not settle');
        if (bridgeIdentity) await requireBridgeExit(bridgeIdentity);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      throw new AggregateError([...(primary ? [primary] : []), ...errors], 'Admission fixture cleanup failed.');
    }
  }
}
