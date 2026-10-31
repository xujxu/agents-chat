import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { admitLinuxCompatibility } from '../scripts/deployment/linux-compatibility.mjs';
import { acquireLock, loadState, releaseLock, writeState } from '../scripts/deployment/state.mjs';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const baseline = '638c553c62406dbb7e6b5aeb41cdddf4cd6de179';
const settings = `Environment=NODE_ENV=production
Environment=NEXTAUTH_SECRET=private-fixture-secret
Environment=NEXTAUTH_URL=http://localhost:3010
Environment=ADMIN_USERNAME=fixture
Environment=ADMIN_PASSWORD=private-fixture-password`;

async function installation(t, options = {}) {
  const f = await fixture(t, { nonroot: true, settings, ...options });
  await ready(f);
  await execute('git', ['clone', '--quiet', '--bare', '--shared', repository, path.join(f.project, '.git')]);
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  const control = path.join(path.dirname(f.project), 'control');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project: f.project, operationId: randomUUID() });
  const saved = await saveWorkerEngine({
    source: fileURLToPath(new URL('../scripts/deployment/', import.meta.url)),
    control, project: f.project, operationId: lock.operationId,
  });
  const operation = await createWorkerOperation({ control, lock, saved });
  t.after(() => operation.close());
  return { ...f, service, operation, control, lock };
}

for (const historical of [false, true]) {
  test(`native compatibility composes observed runtime/config/data before downtime (historical=${historical})`, async t => {
    const f = await installation(t);
    const commit = historical ? baseline
      : (await execute('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    const before = (await readdir(f.project)).sort();
    const result = await admitLinuxCompatibility({ ...f, commit });
    assert.equal(result.compatibility, 'passed');
    assert.equal(result.commit, commit);
    assert.equal(result.mode, historical ? 'historical' : 'declared');
    assert.deepEqual(result.pendingChecks, []);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
    await result.check();
    assert.deepEqual((await readdir(f.project)).sort(), before);
    await f.operation.seal();
    assert.equal((await f.service.check()).populated, true);
  });
}

test('missing authentication refuses native compatibility while original runtime remains running', async t => {
  const f = await installation(t, { settings: 'Environment=NODE_ENV=production' });
  await assert.rejects(admitLinuxCompatibility({ ...f, commit: baseline }),
    { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
  await f.operation.seal();
  assert.equal((await f.service.check()).populated, true);
});

test('legacy import refusal occurs before downtime in composed native admission', async t => {
  const f = await installation(t);
  await writeFile(path.join(f.project, 'agents.json'), 'private-invalid-json');
  await assert.rejects(admitLinuxCompatibility({ ...f, commit: baseline }),
    { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED', check: 'legacy-json' });
  await f.operation.seal();
  assert.equal((await f.service.check()).populated, true);
});

test('retained compatibility recheck detects changed config and newly incompatible data', async t => {
  for (const change of ['configuration', 'data']) {
    const f = await installation(t);
    const result = await admitLinuxCompatibility({ ...f, commit: baseline });
    if (change === 'configuration') {
      await writeFile(path.join(f.project, '.env'), 'NEXTAUTH_SECRET=changed');
      await assert.rejects(result.check(), { code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED' });
    } else {
      await writeFile(path.join(f.project, 'nodes.json'), 'private-invalid-json');
      await assert.rejects(result.check(), { check: 'legacy-json' });
    }
    await f.operation.seal();
    assert.equal((await f.service.check()).populated, true);
  }
});

async function recordPreflight(f) {
  const state = {
    version: 1, operationId: f.lock.operationId, project: f.project, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: baseline, targetCommit: baseline,
    backupId: null, priorRuntime: 'running', runtimeIdentity: f.service.identity.runtime.invocationId,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), errorCode: null,
  };
  await writeState(f.control, state);
  return state;
}

test('settled refused admission retires worker evidence and unlocks without pretending deployment succeeded', async t => {
  const { closeRejectedLinuxPreflight } = await import('../scripts/deployment/linux-preflight-refusal.mjs');
  const f = await installation(t);
  await recordPreflight(f);
  await writeFile(path.join(f.project, 'agents.json'), 'private-invalid-json');
  await assert.rejects(admitLinuxCompatibility({ ...f, commit: baseline }), { check: 'legacy-json' });
  const result = await closeRejectedLinuxPreflight(f);
  assert.equal(result.status, 'preflight-refused');
  assert.equal((await loadState(f.control)).phase, 'preflight-refused');
  assert.equal((await f.service.check()).populated, true);
  assert.equal((await readdir(f.control)).some(name => name === 'lock' || name.startsWith('worker-')), false);
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  await releaseLock(f.control, lock);
});

test('failed-preflight cleanup cannot be used after downtime was recorded', async t => {
  const { closeRejectedLinuxPreflight } = await import('../scripts/deployment/linux-preflight-refusal.mjs');
  const f = await installation(t);
  const state = await recordPreflight(f);
  await writeState(f.control, { ...state, phase: 'stopped', previousPhase: 'preflight' });
  await assert.rejects(closeRejectedLinuxPreflight(f), { code: 'DEPLOYMENT_PREFLIGHT_CLOSEOUT_REFUSED' });
  assert.ok((await readdir(f.control)).includes('lock'));
  assert.equal((await loadState(f.control)).phase, 'stopped');
  assert.equal((await f.service.check()).populated, true);
});

test('retained native compatibility accepts the new stage cancellation signal instead of keeping an expired one', async t => {
  const f = await installation(t);
  const old = new AbortController();
  const result = await admitLinuxCompatibility({ ...f, commit: baseline, signal: old.signal });
  old.abort(new Error('old admission stage is no longer active'));
  await result.check({ signal: new AbortController().signal });
  const cancelled = new AbortController();
  const reason = new Error('new stage cancelled');
  cancelled.abort(reason);
  await assert.rejects(result.check({ signal: cancelled.signal }), error => error === reason);
  await f.operation.seal();
  assert.equal((await f.service.check()).populated, true);
});
