import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import {
  nextPhase, recoveryAdvice, loadState, writeState, acquireLock, releaseLock,
} from '../scripts/deployment/state.mjs';

test('upgrade cannot replace dependencies before a complete backup', () => {
  assert.throws(() => nextPhase('copying', 'dependencies'), /transition/i);
  assert.equal(nextPhase('backup-ready', 'source-selected'), 'source-selected');
  assert.equal(nextPhase('activation-unverified', 'accepted'), 'accepted');
  assert.throws(() => nextPhase('copying', 'accepted'), /transition/i);
  assert.throws(() => nextPhase('invented', 'accepted'), /phase/i);
});

test('failure exposes a concrete recovery command without claiming rollback', () => {
  const command = "sudo bash '/srv/.chat.deployment/restore.sh'";
  const advice = recoveryAdvice({
    operation: 'upgrade', phase: 'building', backupComplete: true, restored: false,
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
    operation: 'upgrade', phase: 'building', backupComplete: true, restored: false,
    diagnosticCommand: 'journalctl -u agents-chat',
  }), /command/i);
});

test('state persists a complete record and rejects malformed state', async t => {
  const root = await temporaryDeployment(t);
  assert.equal(await loadState(root), null);
  const state = {
    version: 1, operationId: 'operation-1', project: root, operation: 'upgrade',
    phase: 'preflight', previousPhase: null, sourceCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40), backupId: null,
    priorRuntime: 'running', runtimeIdentity: 'fixture',
    startedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
    errorCode: null,
  };
  await writeState(root, state);
  assert.deepEqual(await loadState(root), state);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).phase, 'preflight');
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
