import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeHistoryProbe } from '../app/features/diagnostics/nativeHistoryProbe.ts';

function fixture() {
  const value = {
    now: 0, scale: 1, width: 428, clientWidth: 428, orientation: 'portrait',
    touches: 0, editable: false, historyLength: 1, entry: null, sameUrl: true,
    documentContinuous: true, shellContinuous: true, composerContinuous: true,
  };
  let checkpoints = 0;
  let backs = 0;
  let throwCheckpoint = false;
  let throwBack = false;
  const events = [];
  const probe = createNativeHistoryProbe({
    read: () => ({ ...value }),
    checkpoint() {
      checkpoints++;
      if (throwCheckpoint) throw new Error('private history data');
      value.historyLength = 2;
      value.entry = 'working';
    },
    back() {
      backs++;
      if (throwBack) throw new Error('private navigation data');
    },
    publish: event => events.push(event),
  });
  const tick = (advance = 100, event = 'tick') => {
    value.now += advance;
    probe.observe(event);
  };
  const arm = () => {
    probe.arm();
    tick(); tick(); tick();
    assert.equal(probe.evidence().phase, 'armed');
  };
  const rotate = () => {
    Object.assign(value, { scale: 2.16, width: 385, clientWidth: 832, orientation: 'landscape' });
    tick(100, 'orientation'); tick(); tick(); tick();
  };
  return {
    value, probe, events, tick, arm, rotate,
    counts: () => ({ checkpoints, backs }),
    failCheckpoint: () => { throwCheckpoint = true; },
    failBack: () => { throwBack = true; },
  };
}

test('owns one checkpoint and restores only after native geometry settles', () => {
  const f = fixture();
  f.arm();
  assert.deepEqual(f.counts(), { checkpoints: 1, backs: 0 });
  f.rotate();
  f.probe.restore();
  f.probe.restore();
  assert.deepEqual(f.counts(), { checkpoints: 1, backs: 1 });
  assert.equal(f.probe.evidence().phase, 'restoring');
  f.value.entry = 'checkpoint';
  f.tick(10, 'popstate');
  Object.assign(f.value, { scale: 1, width: 832 });
  f.tick();
  assert.notEqual(f.probe.evidence().phase, 'restored');
  f.tick(); f.tick(); f.tick();
  assert.equal(f.probe.evidence().phase, 'restored');
  assert.equal(f.probe.evidence().owned, true);
  f.probe.arm(); f.probe.restore();
  assert.deepEqual(f.counts(), { checkpoints: 1, backs: 1 });
});

test('arming rejects unsafe or inconsistent initial state without writing history', () => {
  for (const change of [
    { scale: null }, { scale: NaN }, { scale: 1.02 }, { width: 390 },
    { width: null }, { width: Infinity }, { clientWidth: 0 },
    { touches: 1 }, { editable: true }, { historyLength: 2 }, { sameUrl: false },
    { documentContinuous: false }, { shellContinuous: false }, { composerContinuous: false },
  ]) {
    const f = fixture();
    Object.assign(f.value, change);
    f.probe.arm();
    f.tick(); f.tick(); f.tick();
    assert.equal(f.counts().checkpoints, 0, JSON.stringify(change));
    assert.notEqual(f.probe.evidence().reason, 'none');
  }
});

test('arming is cancelled by a new gesture or navigation and never retries itself', () => {
  for (const event of ['touch', 'popstate', 'navigation', 'lifecycle']) {
    const f = fixture();
    f.probe.arm();
    f.tick(100, event);
    f.tick(400);
    assert.equal(f.counts().checkpoints, 0);
    assert.equal(f.probe.evidence().phase, 'invalidated');
  }
});

test('restoration requires rotation and settled, enlarged, untouched native viewport', () => {
  const unchanged = fixture();
  unchanged.arm();
  unchanged.probe.restore();
  assert.equal(unchanged.counts().backs, 0);
  for (const change of [{ touches: 1 }, { editable: true }, { scale: 1 }, { scale: null }]) {
    const f = fixture();
    f.arm(); f.rotate();
    Object.assign(f.value, change);
    f.probe.restore();
    assert.equal(f.counts().backs, 0);
  }
  const unstable = fixture();
  unstable.arm();
  Object.assign(unstable.value, { scale: 2, width: 416, clientWidth: 832, orientation: 'landscape' });
  unstable.tick(1, 'orientation');
  unstable.probe.restore();
  assert.equal(unstable.counts().backs, 0);
});

test('ownership and lifecycle loss never navigate or try to repair history', () => {
  for (const change of [
    { entry: null }, { sameUrl: false }, { historyLength: 3 },
    { documentContinuous: false }, { shellContinuous: false }, { composerContinuous: false },
  ]) {
    const f = fixture();
    f.arm(); f.rotate();
    Object.assign(f.value, change);
    f.probe.restore();
    assert.equal(f.probe.evidence().phase, 'invalidated');
    assert.equal(f.counts().backs, 0);
  }
  const f = fixture();
  f.arm();
  f.tick(10, 'lifecycle');
  assert.equal(f.probe.evidence().phase, 'invalidated');
});

test('missing or wrong acknowledgment and unchanged scale are explicit failures', () => {
  const missing = fixture();
  missing.arm(); missing.rotate(); missing.probe.restore();
  missing.tick(3100);
  assert.equal(missing.probe.evidence().phase, 'not-restored');
  assert.equal(missing.probe.evidence().reason, 'ack-timeout');
  const wrong = fixture();
  wrong.arm(); wrong.rotate(); wrong.probe.restore();
  wrong.value.entry = null;
  wrong.tick(10, 'popstate');
  assert.equal(wrong.probe.evidence().phase, 'invalidated');
  const enlarged = fixture();
  enlarged.arm(); enlarged.rotate(); enlarged.probe.restore();
  enlarged.value.entry = 'checkpoint';
  enlarged.tick(10, 'popstate');
  enlarged.tick(3100);
  assert.equal(enlarged.probe.evidence().phase, 'not-restored');
  assert.equal(enlarged.probe.evidence().reason, 'scale-timeout');
  assert.equal(enlarged.counts().backs, 1);
});

test('scale 1 with wrong geometry or remounted DOM cannot be reported restored', () => {
  for (const change of [{ scale: 1, width: 385 }, { scale: 1, width: 832, shellContinuous: false }]) {
    const f = fixture();
    f.arm(); f.rotate(); f.probe.restore();
    f.value.entry = 'checkpoint';
    f.tick(10, 'popstate');
    Object.assign(f.value, change);
    f.tick(); f.tick(); f.tick(); f.tick(); f.tick(3000);
    assert.notEqual(f.probe.evidence().phase, 'restored');
  }
});

test('history API exceptions consume the attempt and do not leak exception text', () => {
  const arm = fixture();
  arm.failCheckpoint();
  arm.probe.arm(); arm.tick(); arm.tick(); arm.tick(); arm.probe.arm();
  assert.equal(arm.probe.evidence().phase, 'error');
  assert.equal(arm.probe.evidence().reason, 'history-error');
  assert.equal(arm.counts().checkpoints, 1);
  const restore = fixture();
  restore.arm(); restore.rotate(); restore.failBack();
  restore.probe.restore(); restore.probe.restore();
  assert.equal(restore.probe.evidence().phase, 'error');
  assert.equal(restore.counts().backs, 1);
  assert.equal(JSON.stringify([...arm.events, ...restore.events]).includes('private'), false);
});

test('late acknowledgments and transient original-scale readings do not pass', () => {
  const late = fixture();
  late.arm(); late.rotate(); late.probe.restore();
  late.value.entry = 'checkpoint';
  late.tick(3100, 'popstate');
  assert.equal(late.probe.evidence().reason, 'ack-timeout');
  const transient = fixture();
  transient.arm(); transient.rotate(); transient.probe.restore();
  transient.value.entry = 'checkpoint';
  transient.tick(10, 'popstate');
  Object.assign(transient.value, { scale: 1, width: 832 });
  transient.tick();
  Object.assign(transient.value, { scale: 2.16, width: 385 });
  transient.tick(); transient.tick(3100);
  assert.equal(transient.probe.evidence().phase, 'not-restored');
});

test('a released control tap permits restoration but an active touch does not', () => {
  const f = fixture();
  f.arm(); f.rotate();
  f.value.touches = 1;
  f.tick(10, 'touch');
  f.probe.restore();
  assert.equal(f.counts().backs, 0);
  f.value.touches = 0;
  f.tick(10);
  f.probe.restore();
  assert.equal(f.counts().backs, 1);
});
