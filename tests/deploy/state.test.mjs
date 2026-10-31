import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeployError,
  backupName,
  beginSwitch,
  checkSkipInstall,
  chooseRestoreTarget,
  completeSwitch,
  emptyState,
  evaluatePreflight,
  failSwitch,
  lockStatus,
  planPrune,
  recoveryPlan,
  releaseId,
  updatePending,
} from '../../scripts/deploy/state.mjs';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

function installed(overrides = {}) {
  return {
    ...emptyState(),
    current: 'c',
    previous: ['b', 'a'],
    backups: { b: 'b--1', a: 'a--1' },
    lockHash: 'h1',
    ...overrides,
  };
}

const okFacts = {
  op: 'update',
  isElevated: true,
  nodeMajor: 24,
  hasGit: true,
  lockHeld: false,
  freeBytes: 10 * 1024 ** 3,
  dataBytes: 100,
  hasEnvLocal: true,
  installed: true,
  serviceExists: true,
};

test('release and backup names are sortable and include the commit', () => {
  assert.equal(releaseId('0123456789abcdef', NOW), '0123456789ab-20261031T120000Z');
  assert.equal(backupName('r1', NOW), 'r1--20261031T120000Z');
});

test('restore defaults to the most recent previous release with a backup', () => {
  assert.equal(chooseRestoreTarget(installed(), null, ['a', 'b', 'c']), 'b');
});

test('restore skips previous releases whose folder or backup is gone', () => {
  assert.equal(chooseRestoreTarget(installed(), null, ['a', 'c']), 'a');
  const noBackup = installed({ backups: { a: 'a--1' } });
  assert.equal(chooseRestoreTarget(noBackup, null, ['a', 'b', 'c']), 'a');
});

test('restore accepts a release id, its prefix, or a full commit sha', () => {
  const s = installed({ previous: ['0123456789ab-20261031T120000Z'], backups: { '0123456789ab-20261031T120000Z': 'x--1' } });
  const releases = ['0123456789ab-20261031T120000Z', 'c'];
  assert.equal(chooseRestoreTarget(s, '0123456', releases), '0123456789ab-20261031T120000Z');
  assert.equal(chooseRestoreTarget(s, '0123456789abcdef0000', releases), '0123456789ab-20261031T120000Z');
});

test('restore refuses when nothing matches', () => {
  assert.throws(() => chooseRestoreTarget(installed({ previous: [] }), null, ['c']), (e) => e instanceof DeployError && e.exitCode === 2);
  assert.throws(() => chooseRestoreTarget(installed(), 'zzz', ['a', 'b', 'c']), DeployError);
});

test('prune keeps current and the two most recent previous releases', () => {
  const s = installed({ previous: ['b', 'a', 'z'], backups: { b: 'b--1', a: 'a--1', z: 'z--1' } });
  const plan = planPrune(s, ['a', 'b', 'c', 'z', 'y.tmp'], ['a--1', 'b--1', 'z--1', 'migration-1']);
  assert.deepEqual(plan.releases.sort(), ['y.tmp', 'z']);
  assert.deepEqual(plan.backups, ['z--1']);
  assert.deepEqual(plan.state.previous, ['b', 'a']);
  assert.deepEqual(plan.state.backups, { b: 'b--1', a: 'a--1' });
});

test('prune never removes current or previous[0], and ignores missing folders', () => {
  const plan = planPrune(installed({ previous: ['gone', 'b', 'a'] }), ['a', 'b', 'c'], []);
  assert.deepEqual(plan.releases, []);
  assert.deepEqual(plan.state.previous, ['b', 'a']);
});

test('no recovery when nothing is pending', () => {
  assert.equal(recoveryPlan(installed()), null);
});

test('interrupted update before the snapshot only relinks and restarts', () => {
  const s = beginSwitch(installed(), { op: 'update', from: 'c', to: 'd', now: NOW });
  assert.deepEqual(recoveryPlan(s), { removeService: false, restoreService: null, relinkTo: 'c', restoreData: null, start: true });
});

test('interrupted update after the snapshot also restores data', () => {
  let s = beginSwitch(installed(), { op: 'update', from: 'c', to: 'd', now: NOW });
  s = updatePending(s, { step: 'health', backup: 'c--1' });
  assert.equal(recoveryPlan(s).restoreData, 'c--1');
});

test('interrupted install removes the service; interrupted import restores the old one', () => {
  const install = beginSwitch(emptyState(), { op: 'install', from: null, to: 'd', now: NOW });
  assert.equal(recoveryPlan(install).removeService, true);
  let imp = beginSwitch(emptyState(), { op: 'import', from: null, to: 'd', now: NOW });
  imp = updatePending(imp, { serviceBackup: 'migration-1' });
  assert.deepEqual(recoveryPlan(imp), { removeService: false, restoreService: 'migration-1', relinkTo: null, restoreData: null, start: true });
});

test('lock status distinguishes free, held and stale locks', () => {
  assert.equal(lockStatus(null, () => true), 'free');
  assert.equal(lockStatus({ pid: 42 }, () => true), 'held');
  assert.equal(lockStatus({ pid: 42 }, () => false), 'stale');
});

test('preflight passes for a healthy update and reports every failure', () => {
  assert.deepEqual(evaluatePreflight(okFacts), []);
  const errors = evaluatePreflight({ ...okFacts, isElevated: false, nodeMajor: 20, hasGit: false, lockHeld: true, freeBytes: 0 });
  assert.equal(errors.length, 5);
});

test('preflight enforces install vs. update preconditions', () => {
  assert.equal(evaluatePreflight({ ...okFacts, op: 'install' }).length, 2);
  assert.equal(evaluatePreflight({ ...okFacts, op: 'install', installed: false, serviceExists: false }).length, 0);
  assert.equal(evaluatePreflight({ ...okFacts, op: 'import', installed: false, serviceExists: false }).length, 1);
  assert.equal(evaluatePreflight({ ...okFacts, installed: false }).length, 1);
  assert.equal(evaluatePreflight({ ...okFacts, op: 'restore', serviceExists: false }).length, 1);
});

test('restore needs no git and no build headroom', () => {
  assert.deepEqual(evaluatePreflight({ ...okFacts, op: 'restore', hasGit: false, freeBytes: 1000 }), []);
});

test('-NoInstall is refused unless the lock hash matches', () => {
  assert.doesNotThrow(() => checkSkipInstall(installed(), 'h1'));
  assert.throws(() => checkSkipInstall(installed(), 'h2'), (e) => e.exitCode === 2);
  assert.throws(() => checkSkipInstall(emptyState(), 'h1'), DeployError);
});

test('completing an update records history, backup and result', () => {
  let s = beginSwitch(installed(), { op: 'update', from: 'c', to: 'd', now: NOW });
  s = updatePending(s, { backup: 'c--1' });
  s = completeSwitch(s, { verified: true, lockHash: 'h2', now: NOW });
  assert.equal(s.current, 'd');
  assert.deepEqual(s.previous, ['c', 'b', 'a']);
  assert.equal(s.backups.c, 'c--1');
  assert.equal(s.pending, null);
  assert.equal(s.lockHash, 'h2');
  assert.equal(s.lastResult.outcome, 'succeeded');
});

test('completing a restore moves the target out of previous', () => {
  let s = beginSwitch(installed(), { op: 'restore', from: 'c', to: 'b', now: NOW });
  s = updatePending(s, { backup: 'c--2' });
  s = completeSwitch(s, { verified: true, now: NOW });
  assert.equal(s.current, 'b');
  assert.deepEqual(s.previous, ['c', 'a']);
  assert.equal(s.backups.c, 'c--2');
});

test('a failed switch keeps the old current and records the step', () => {
  let s = beginSwitch(installed(), { op: 'update', from: 'c', to: 'd', now: NOW });
  s = updatePending(s, { step: 'health' });
  s = failSwitch(s, { outcome: 'rolled-back', message: 'health timed out', now: NOW });
  assert.equal(s.current, 'c');
  assert.equal(s.pending, null);
  assert.deepEqual(
    { ...s.lastResult, at: undefined },
    { op: 'update', from: 'c', to: 'd', outcome: 'rolled-back', step: 'health', at: undefined, message: 'health timed out' },
  );
});
