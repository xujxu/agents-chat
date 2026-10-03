import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function savedModules(control) {
  const load = name => import(pathToFileURL(path.join(control, 'recovery-engine', name)).href);
  return {
    api: await load('windows-task-completion-proof.mjs'),
    ...await load('windows-admission.mjs'),
    ...await load('process-identity.mjs'),
  };
}

if (process.argv[2] === 'hold-recovery') {
  const [control, pwsh] = process.argv.slice(3);
  const { api, withWindowsAdmission } = await savedModules(control);
  await withWindowsAdmission(control, { pwsh }, async admission => {
    const scope = await api.openWindowsTaskCompletionRecovery({ control, pwsh, admission });
    try {
      await scope.advance();
      await new Promise((resolve, reject) => process.send({
        pid: process.pid, native: scope.identity, admission: admission.identity, observation: scope.observation,
      }, error => error ? reject(error) : resolve()));
      await delay(120000);
      throw new Error('Parent did not terminate the held recovery actor.');
    } finally { await scope.close(); }
  });
}

export async function recoverAfterActorLoss({ control, pwsh, finish }) {
  const { api, withWindowsAdmission, processIdentity } = await savedModules(control);
  const child = fork(fileURLToPath(import.meta.url), ['hold-recovery', control, pwsh], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
  const signal = AbortSignal.timeout(120000);
  const exited = once(child, 'exit', { signal });
  const settled = async identity => {
    const deadline = Date.now() + 15000;
    while (await processIdentity(identity.pid) === identity.processIdentity) {
      assert.ok(Date.now() < deadline, 'Original recovery helper did not settle');
      await delay(50);
    }
  };
  try {
    const [held] = await Promise.race([
      once(child, 'message', { signal }),
      exited.then(() => { throw new Error(`Recovery actor exited before retention: ${stderr}`); }),
    ]);
    assert.equal(held.pid, child.pid);
    assert.equal(held.observation.phase, 'released');
    assert.equal(await processIdentity(held.native.pid), held.native.processIdentity);
    assert.equal(await processIdentity(held.admission.pid), held.admission.processIdentity);
    process.kill(held.admission.pid);
    await settled(held.admission);
    await withWindowsAdmission(control, { pwsh }, async admission => {
      try {
        await assert.rejects(api.openWindowsTaskCompletionRecovery({ control, pwsh, admission }), error =>
          error.code === 'DEPLOYMENT_WINDOWS_COMPLETION_RECOVERY_REFUSED'
          && /records-complete-release-requested/.test(error.diagnostic));
        assert.equal(await processIdentity(held.native.pid), held.native.processIdentity,
          'The old native bridge must remain alive after admission loss');
      } finally {
        child.kill();
        await exited;
        await settled(held.native);
      }
      await finish(admission, held.observation);
    });
    console.log('PASS: admission loss cannot overlap a retained native recovery bridge; actor death permits exact replay');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}
