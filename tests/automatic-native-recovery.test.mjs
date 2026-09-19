import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomaticNativeRecovery } from '../app/features/diagnostics/automaticNativeRecovery.ts';

function fixture() {
  const o = {
    now: 0, scale: 1, width: 428, clientWidth: 428, scrollWidth: 428,
    orientation: 'portrait', touches: 0, editable: false, overlay: false,
    historyLength: 1, entry: null, entryCycle: null, sameUrl: true,
    documentContinuous: true, shellContinuous: true, composerContinuous: true,
  };
  const count = { checkpoint: 0, back: 0, rearm: 0 };
  const events = [];
  let failing = '';
  const op = name => { count[name]++; if (failing === name) throw new Error('private exception'); };
  const c = createAutomaticNativeRecovery({
    read: () => ({ ...o }),
    checkpoint() { op('checkpoint'); Object.assign(o, { historyLength: 2, entry: 'working', entryCycle: 0 }); },
    back() { op('back'); },
    rearm() { op('rearm'); o.entry = 'working'; o.entryCycle++; },
    publish: e => events.push(e),
  });
  const tick = (ms = 100, event = 'tick') => { o.now += ms; c.observe(event); };
  const settle = () => { tick(); tick(); tick(); tick(); };
  const arm = () => { c.arm(); settle(); assert.equal(c.evidence().phase, 'watching'); };
  const rotate = (scale = 2.16, consistent = true) => {
    o.orientation = o.orientation === 'portrait' ? 'landscape' : 'portrait';
    o.clientWidth = o.orientation === 'portrait' ? 428 : 832;
    o.scrollWidth = o.clientWidth;
    o.scale = scale;
    o.width = consistent ? o.clientWidth / scale : o.clientWidth;
    tick(1, 'orientation');
  };
  const acknowledge = () => { o.entry = 'checkpoint'; tick(1, 'popstate'); };
  const recover = () => { acknowledge(); o.scale = 1; o.width = o.clientWidth; settle(); };
  const pinch = scale => {
    o.touches = 2; tick(1, 'touch');
    o.scale = scale; o.width = o.clientWidth / scale;
    o.touches = 0; settle();
  };
  return { o, c, count, events, tick, settle, arm, rotate, acknowledge, recover, pinch, fail: name => { failing = name; } };
}

test('many automatic cycles reuse one owned pair with no accumulating history', () => {
  const f = fixture(); f.arm();
  for (let i = 1; i <= 20; i++) {
    f.pinch(1);
    f.rotate(); f.settle();
    assert.equal(f.c.evidence().phase, 'restoring');
    assert.equal(f.count.back, i);
    f.recover();
    assert.equal(f.c.evidence().phase, 'watching');
    assert.equal(f.c.evidence().corrections, i);
    assert.equal(f.c.evidence().cycle, i);
    assert.equal(f.o.historyLength, 2);
  }
  assert.deepEqual(f.count, { checkpoint: 1, back: 20, rearm: 20 });
});

test('intentional nonunit pinch is not normalized by rotation', () => {
  const f = fixture(); f.arm(); f.pinch(2);
  assert.equal(f.c.evidence().intent, 'intentional-nonunit');
  f.rotate(3); f.settle();
  assert.equal(f.count.back, 0);
  assert.equal(f.c.evidence().intent, 'intentional-nonunit');
  f.pinch(1); f.rotate(); f.settle();
  assert.equal(f.count.back, 1);
});

test('resize alone and inconsistent rotation geometry never trigger navigation', () => {
  const resize = fixture(); resize.arm();
  resize.o.scale = 2; resize.o.width = 214; resize.settle();
  assert.equal(resize.count.back, 0);
  assert.equal(resize.c.evidence().intent, 'unknown');
  resize.rotate(); resize.settle();
  assert.equal(resize.count.back, 0);
  const f = fixture(); f.arm();
  f.rotate(2, false); f.settle();
  assert.equal(f.count.back, 0);
  f.tick(3100);
  assert.equal(f.c.evidence().reason, 'unassessed');
  f.rotate(); f.settle();
  assert.equal(f.count.back, 1);
});

test('normal settled rotation does not authorize later unattributed zoom to be reset', () => {
  const f = fixture(); f.arm(); f.rotate(1); f.settle();
  assert.equal(f.c.evidence().phase, 'watching');
  f.o.scale = 2; f.o.width = f.o.clientWidth / 2; f.settle();
  assert.equal(f.c.evidence().intent, 'unknown');
  f.rotate(); f.settle();
  assert.equal(f.count.back, 0);
});

test('duplicate orientation notifications cannot extend the fixed assessment deadline', () => {
  const f = fixture(); f.arm(); f.rotate(2, false);
  for (let i = 0; i < 35; i++) f.tick(100, 'orientation');
  assert.equal(f.count.back, 0);
  assert.equal(f.c.evidence().orientationEpoch, 1);
  assert.equal(f.c.evidence().reason, 'unassessed');
  f.o.width = f.o.clientWidth / 2; f.settle();
  assert.equal(f.count.back, 0);
});

test('contact or focused input cancels an assessment without resetting user zoom', () => {
  for (const change of [{ touches: 1 }, { touches: 2 }, { editable: true }]) {
    const f = fixture(); f.arm(); f.rotate();
    Object.assign(f.o, change); f.tick(10, change.editable ? 'focus' : 'touch');
    Object.assign(f.o, { touches: 0, editable: false }); f.settle(); f.tick(4000);
    assert.equal(f.count.back, 0);
  }
});

test('focus exit requires a fresh settled original-scale baseline', () => {
  const f = fixture(); f.arm();
  f.o.editable = true; f.tick(1, 'focus');
  assert.equal(f.c.evidence().intent, 'unknown');
  f.o.editable = false; f.tick(1, 'focus'); f.tick(); f.tick();
  assert.equal(f.c.evidence().intent, 'unknown');
  f.tick(); f.tick();
  assert.equal(f.c.evidence().intent, 'original');
  assert.equal(f.count.back, 0);
});

test('ownership changes, overlays, URL changes and DOM replacements stop the controller', () => {
  for (const change of [
    { entry: null }, { entryCycle: 9 }, { historyLength: 3 }, { sameUrl: false },
    { documentContinuous: false }, { shellContinuous: false }, { composerContinuous: false },
    { overlay: true },
  ]) {
    const f = fixture(); f.arm();
    Object.assign(f.o, change); f.tick();
    assert.equal(f.c.evidence().phase, 'stopped');
    assert.equal(f.count.back, 0);
  }
});

test('external Back and explicit stop do not rearm or compensate with more navigation', () => {
  const back = fixture(); back.arm();
  back.o.entry = 'checkpoint'; back.tick(10, 'popstate');
  assert.equal(back.c.evidence().phase, 'stopped');
  assert.equal(back.count.rearm, 0);
  const stopped = fixture(); stopped.arm(); stopped.rotate(); stopped.settle();
  stopped.c.stop(); stopped.recover();
  assert.equal(stopped.c.evidence().phase, 'stopped');
  assert.deepEqual(stopped.count, { checkpoint: 1, back: 1, rearm: 0 });
  stopped.o.shellContinuous = false;
  assert.equal(stopped.c.evidence().shellContinuous, false);
});

test('failed acknowledgment or scale recovery ends the trial without retry loops', () => {
  for (const ack of [false, true]) {
    const f = fixture(); f.arm(); f.rotate(); f.settle();
    if (ack) f.acknowledge();
    f.tick(3100);
    assert.equal(f.c.evidence().phase, 'error');
    assert.equal(f.c.evidence().reason, ack ? 'scale-timeout' : 'ack-timeout');
    f.rotate(); f.settle(); f.c.arm();
    assert.equal(f.count.back, 1);
    assert.equal(f.count.rearm, 0);
  }
});

test('API errors at each operation are explicit and do not expose exception text', () => {
  for (const op of ['checkpoint', 'back', 'rearm']) {
    const f = fixture();
    if (op === 'checkpoint') { f.fail(op); f.c.arm(); f.settle(); }
    else {
      f.arm(); f.fail(op); f.rotate(); f.settle();
      if (op === 'rearm') f.recover();
    }
    assert.equal(f.c.evidence().phase, 'error');
    assert.equal(f.c.evidence().reason, 'history-error');
    assert.equal(JSON.stringify(f.events).includes('private'), false);
  }
});

test('unsafe initial states are refused without history writes', () => {
  for (const change of [
    { historyLength: 2 }, { scale: 2 }, { width: null }, { scale: NaN },
    { overlay: true }, { editable: true }, { touches: 1 }, { scrollWidth: 1000 },
  ]) {
    const f = fixture(); Object.assign(f.o, change);
    f.c.arm(); f.settle();
    assert.equal(f.count.checkpoint, 0);
    assert.notEqual(f.c.evidence().reason, 'none');
  }
});

test('a new orientation during restoration invalidates the in-flight epoch', () => {
  const f = fixture(); f.arm(); f.rotate(); f.settle();
  f.rotate(); f.recover();
  assert.equal(f.c.evidence().phase, 'stopped');
  assert.equal(f.count.rearm, 0);
});
