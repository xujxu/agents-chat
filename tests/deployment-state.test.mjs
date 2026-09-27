import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import {
  nextPhase, recoveryAdvice, loadState, writeState, acquireLock, releaseLock,
} from '../scripts/deployment/state.mjs';

test('update cannot replace dependencies before a complete backup', () => {
  assert.throws(() => nextPhase('copying', 'dependencies'), /transition/i);
  assert.equal(nextPhase('backup-ready', 'source-selected'), 'source-selected');
  assert.equal(nextPhase('activation-unverified', 'accepted'), 'accepted');
  assert.throws(() => nextPhase('copying', 'accepted'), /transition/i);
  assert.throws(() => nextPhase('invented', 'accepted'), /phase/i);
});

test('failure exposes a concrete recovery command without claiming rollback', () => {
  const command = "sudo bash '/srv/.chat.deployment/restore.sh'";
  const advice = recoveryAdvice({
    operation: 'update', phase: 'building', backupComplete: true, restored: false,
    restoreCommand: command,
    diagnosticCommand: 'sudo journalctl -u agents-chat -n 40 --no-pager',
  });
  assert.equal(advice.status, 'recovery-required');
  assert.equal(advice.command, command);
  assert.match(advice.message, /not restored/i);
  assert.match(advice.message, /building/i);
  assert.equal(advice.diagnostics, 'sudo journalctl -u agents-chat -n 40 --no-pager');
});

test('first installation never invents a rollback backup', () => {
  const command = "sudo bash '/srv/chat/scripts/deploy.sh' --no-pull";
  const advice = recoveryAdvice({
    operation: 'deploy', phase: 'building', backupComplete: false, restored: false,
    retryCommand: command, diagnosticCommand: 'journalctl -u agents-chat',
  });
  assert.equal(advice.status, 'no-backup');
  assert.match(advice.message, /no .*backup/i);
  assert.equal(advice.command, command);
});

test('missing recovery command is an error, not empty successful advice', () => {
  assert.throws(() => recoveryAdvice({
    operation: 'update', phase: 'building', backupComplete: true, restored: false,
    diagnosticCommand: 'journalctl -u agents-chat',
  }), /command/i);
});

test('state persists a complete record and rejects malformed state', async t => {
  const root = await temporaryDeployment(t);
  assert.equal(await loadState(root), null);
  const state = {
    version: 1, operationId: 'operation-1', project: root, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40), backupId: null,
    priorRuntime: 'running', runtimeIdentity: 'fixture',
    startedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
    errorCode: null,
  };
  await writeState(root, state);
  assert.deepEqual(await loadState(root), state);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).phase, 'preflight');
  const stopped = { ...state, phase: 'stopped', previousPhase: 'preflight' };
  await writeState(root, stopped);
  assert.deepEqual(await loadState(root), stopped);
  if (process.platform === 'linux') {
    assert.equal((await stat(path.join(root, 'state.json'))).mode & 0o777, 0o600);
  }
  await assert.rejects(writeState(root, {
    ...stopped, phase: 'dependencies', previousPhase: 'stopped',
  }), /transition/i);
  assert.deepEqual(await loadState(root), stopped);
  await writeFile(path.join(root, 'state.json'), '{"version":1,');
  await assert.rejects(loadState(root), /state/i);
});

test('unsupported state versions and extra secret fields are rejected', async t => {
  const root = await temporaryDeployment(t);
  await writeFile(path.join(root, 'state.json'), JSON.stringify({ version: 999 }));
  await assert.rejects(loadState(root), /version/i);
  await assert.rejects(writeState(root, { version: 1, environment: { TOKEN: 'fixture' } }), /field|state/i);
});

test('lock is exclusive and another operation cannot release it', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'first' });
  await assert.rejects(acquireLock(root, { project: root, operationId: 'second' }), /lock|operation/i);
  await assert.rejects(releaseLock(root, { ...lock, token: 'not-the-owner' }), /owner/i);
  await releaseLock(root, lock);
  const next = await acquireLock(root, { project: root, operationId: 'second' });
  await releaseLock(root, next);
});

test('orphaned lock is not silently discarded on reentry', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'interrupted' });
  const ownerPath = path.join(root, 'lock', 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({ ...owner, pid: 2147483647 }));
  await assert.rejects(acquireLock(root, { project: root, operationId: 'retry' }), /lock|inspect/i);
  await writeFile(ownerPath, JSON.stringify(owner));
  await releaseLock(root, lock);
});

test('lock records stable process identity, not only a reusable PID', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'identity' });
  assert.equal(typeof lock.processIdentity, 'string');
  assert.ok(lock.processIdentity.length > 0);
  await assert.rejects(releaseLock(root, {
    ...lock, processIdentity: 'another-process-start',
  }), /owner/i);
  await releaseLock(root, lock);
});

test('deployment interruption reports the live owner or required inspection', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'interrupted' });
  const stateModule = await import('../scripts/deployment/state.mjs');
  assert.equal(typeof stateModule.reconcileInterruptedOperation, 'function');
  const alive = await stateModule.reconcileInterruptedOperation(root);
  assert.equal(alive.status, 'active');
  assert.equal(alive.operationId, 'interrupted');
  const ownerPath = path.join(root, 'lock', 'owner.json');
  await writeFile(ownerPath, JSON.stringify({ ...lock, processIdentity: 'previous-pid-owner' }));
  const reused = await stateModule.reconcileInterruptedOperation(root);
  assert.equal(reused.status, 'interrupted');
  assert.match(reused.message, /inspect/i);
  assert.notEqual(await readFile(ownerPath, 'utf8'), '');
  await writeFile(ownerPath, JSON.stringify(lock));
  await releaseLock(root, lock);
});

test('unsettled worker state survives reentry and forbids releasing its lock or starting restore', async t => {
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'blocked-worker' });
  const initial = {
    version: 1, operationId: 'blocked-worker', project: root, operation: 'update',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40), backupId: null,
    priorRuntime: 'running', runtimeIdentity: 'fixture',
    startedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
    errorCode: null,
  };
  await writeState(root, initial);
  await writeState(root, {
    ...initial, phase: 'blocked', previousPhase: 'preflight',
    errorCode: 'DEPLOYMENT_WORKER_UNSETTLED',
  });
  const { reconcileInterruptedOperation } = await import('../scripts/deployment/state.mjs');
  assert.equal((await reconcileInterruptedOperation(root)).status, 'blocked');
  await assert.rejects(releaseLock(root, lock), /blocked|worker/i);
  await assert.rejects(writeState(root, {
    ...initial, operationId: 'restore-attempt', operation: 'restore', phase: 'restore-preflight',
  }), /blocked|worker/i);
  const retained = JSON.parse(await readFile(path.join(root, 'lock', 'owner.json'), 'utf8'));
  assert.equal(retained.token, lock.token);
  assert.equal((await loadState(root)).phase, 'blocked');
});

test('blocked recovery advice offers inspection, never a restore command', () => {
  const advice = recoveryAdvice({
    phase: 'blocked', backupComplete: true, restored: false,
    restoreCommand: 'must not execute',
    diagnosticCommand: 'node saved-tool.mjs --status --json',
  });
  assert.equal(advice.status, 'blocked');
  assert.equal(advice.command, 'node saved-tool.mjs --status --json');
  assert.match(advice.message, /worker|inspect/i);
  assert.throws(() => nextPhase('blocked', 'restore-preflight'), /transition/i);
});

test('preflight blocking can be persisted before any normal phase write, but never erases incomplete work', async t => {
  const root = await temporaryDeployment(t);
  const record = {
    version: 1, operationId: 'preflight-worker', project: root, operation: 'update',
    phase: 'blocked', previousPhase: null, sourceCommit: null, targetCommit: null,
    backupId: null, priorRuntime: 'unknown', runtimeIdentity: 'unverified',
    startedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
    errorCode: 'DEPLOYMENT_WORKER_UNSETTLED',
  };
  await writeState(root, record);
  assert.deepEqual(await loadState(root), record);
  await writeFile(path.join(root, 'state.json'), JSON.stringify({
    ...record, operationId: 'previous', phase: 'accepted', errorCode: null,
    priorRuntime: 'running',
  }));
  await writeState(root, record);
  assert.deepEqual(await loadState(root), record);
  await writeFile(path.join(root, 'state.json'), JSON.stringify({
    ...record, operationId: 'previous', phase: 'building', errorCode: null,
    priorRuntime: 'running',
  }));
  await assert.rejects(writeState(root, record), /unfinished|recovery/i);
});
