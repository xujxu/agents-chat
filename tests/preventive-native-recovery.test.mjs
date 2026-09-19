import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreventiveNativeRecovery } from '../app/features/diagnostics/preventiveNativeRecovery.ts';

function fixture() {
  const o = {
    now: 0, scale: 1, width: 428, clientWidth: 428, scrollWidth: 428,
    orientation: 'portrait', touches: 0, editable: false, overlay: false,
    historyLength: 1, entry: null, entryCycle: null, sameUrl: true,
    documentContinuous: true, shellContinuous: true, composerContinuous: true,
  };
  const count = { checkpoint: 0, back: 0, rearm: 0 };
  let failing = '';
  let published;
  const operation = name => { count[name]++; if (failing === name) throw new Error('private detail'); };
  const c = createPreventiveNativeRecovery({
    read: () => ({ ...o }),
    checkpoint() { operation('checkpoint'); Object.assign(o, { historyLength: 2, entry: 'working', entryCycle: 0 }); },
    back() { operation('back'); },
    rearm() { operation('rearm'); o.entry = 'working'; o.entryCycle++; },
    publish(value) { published = value; },
  });
  const tick = (ms = 100, event = 'tick') => { o.now += ms; c.observe(event); };
  const settle = () => { tick(); tick(); tick(); tick(); };
  const arm = () => { c.arm(); settle(); assert.equal(c.evidence().phase, 'watching'); };
  const start = () => { o.touches = 2; tick(1, 'touch'); o.scale = 2; o.width = o.clientWidth / 2; tick(); };
  const release = (scale = 1, width = o.clientWidth / scale) => {
    Object.assign(o, { scale, width, touches: 0 }); tick(1, 'touch');
  };
  const acknowledge = () => { o.entry = 'checkpoint'; tick(1, 'popstate'); };
  const prepare = () => { start(); release(); settle(); assert.equal(c.evidence().phase, 'preparing'); };
  const rotate = () => {
    o.orientation = o.orientation === 'portrait' ? 'landscape' : 'portrait';
    tick(1, 'orientation');
  };
  return { o, c, count, tick, settle, arm, start, release, acknowledge, prepare, rotate,
    fail: name => { failing = name; }, published: () => published };
}

test('twenty preparations reuse one pair before rotation, never reactively correct afterward', () => {
  const f = fixture(); f.arm();
  for (let i = 1; i <= 20; i++) {
    f.prepare(); f.acknowledge(); f.settle();
    assert.equal(f.c.evidence().phase, 'watching');
    assert.equal(f.c.evidence().preparations, i);
    assert.equal(f.c.evidence().cycle, i);
    assert.equal(f.o.historyLength, 2);
    f.rotate();
    f.o.scale = 2; f.o.width = f.o.clientWidth / 2; f.settle();
    assert.equal(f.count.back, i);
  }
  assert.deepEqual(f.count, { checkpoint: 1, back: 20, rearm: 20 });
});

test('enablement, focus, resizes, rotations and contacts without zoom do not prepare', () => {
  const f = fixture(); f.arm(); f.rotate(); f.settle();
  f.o.editable = true; f.tick(1, 'focus');
  f.o.editable = false; f.settle();
  for (const touches of [1, 0, 2, 1, 0]) { f.o.touches = touches; f.tick(1, 'touch'); f.settle(); }
  f.o.scale = 2; f.o.width = f.o.clientWidth / 2; f.settle();
  f.o.scale = 1; f.o.width = f.o.clientWidth; f.settle();
  assert.equal(f.count.back, 0);
});

test('partial release cannot prepare and full release requires fresh stability', () => {
  const f = fixture(); f.arm(); f.start();
  Object.assign(f.o, { scale: 1, width: 428, touches: 1 }); f.settle();
  assert.equal(f.count.back, 0);
  f.release(); f.tick(); f.tick();
  assert.equal(f.count.back, 0);
  f.tick(); f.tick();
  assert.equal(f.count.back, 1);
  f.acknowledge(); f.tick(); f.tick();
  assert.equal(f.count.rearm, 0);
  f.tick(); f.tick();
  assert.equal(f.count.rearm, 1);
});

test('near-original full-width geometry uses the established original tolerance', () => {
  for (const scale of [1.004727, 0.995]) {
    const f = fixture();
    Object.assign(f.o, { width: 832, clientWidth: 832, scrollWidth: 832, orientation: 'landscape' });
    f.arm(); f.start(); f.release(scale, 832); f.settle();
    assert.equal(f.count.back, 1);
  }
});

test('intentional zoom and inconsistent geometry cannot authorize preparation', () => {
  for (const [scale, width, intent] of [[1.16834, 428 / 1.16834, 'intentional-nonunit'], [2.018817, 428, 'unknown']]) {
    const f = fixture(); f.arm(); f.start(); f.release(scale, width); f.settle();
    assert.equal(f.c.evidence().intent, intent);
    assert.equal(f.count.back, 0);
    f.tick(3100);
    f.o.scale = 1; f.o.width = 428; f.settle();
    assert.equal(f.count.back, 0);
  }
});

test('new contact, focus and orientation consume the cancelled assessment', () => {
  for (const interruption of ['touch', 'focus', 'orientation']) {
    const f = fixture(); f.arm(); f.start(); f.release();
    if (interruption === 'orientation') f.rotate();
    else {
      if (interruption === 'touch') f.o.touches = 1;
      else f.o.editable = true;
      f.tick(1, interruption);
    }
    Object.assign(f.o, { touches: 0, editable: false }); f.settle(); f.tick(4000);
    assert.equal(f.count.back, 0);
    f.prepare();
    assert.equal(f.count.back, 1);
  }
});

test('rotation while fingers remain down cannot restart the same gesture', () => {
  const f = fixture(); f.arm(); f.start(); f.rotate();
  f.settle(); f.release(); f.settle();
  assert.equal(f.count.back, 0);
});

test('a new multi-touch gesture replaces an older unconsumed assessment', () => {
  const f = fixture(); f.arm(); f.start(); f.release(); f.start(); f.release(); f.settle();
  assert.equal(f.count.back, 1);
  assert.equal(f.c.evidence().gestureEpoch, 2);
});

test('assessment deadline is not extended by viewport observations', () => {
  const f = fixture(); f.arm(); f.start(); f.release(2, 428);
  for (let i = 0; i < 35; i++) f.tick();
  assert.equal(f.c.evidence().reason, 'unassessed');
  f.o.scale = 1; f.settle();
  assert.equal(f.count.back, 0);
});

test('ownership, overlay, overflow and document changes are guarded', () => {
  for (const change of [
    { entry: null }, { historyLength: 3 }, { entryCycle: 99 }, { sameUrl: false },
    { shellContinuous: false }, { composerContinuous: false }, { documentContinuous: false }, { overlay: true },
  ]) {
    const f = fixture(); f.arm(); Object.assign(f.o, change); f.tick();
    assert.equal(f.c.evidence().phase, 'stopped');
    assert.equal(f.count.back, 0);
  }
  const f = fixture(); f.arm(); f.start(); f.release(); f.o.scrollWidth = 500; f.settle();
  assert.equal(f.count.back, 0);
  assert.equal(f.c.evidence().reason, 'overflow');
});

test('Stop and external Back never trigger compensating navigation or rearm', () => {
  const back = fixture(); back.arm(); back.o.entry = 'checkpoint'; back.tick(1, 'popstate');
  assert.equal(back.c.evidence().phase, 'stopped');
  assert.equal(back.count.rearm, 0);
  const f = fixture(); f.arm(); f.prepare(); f.c.stop(); f.acknowledge(); f.settle();
  assert.equal(f.count.rearm, 0);
  assert.equal(f.c.evidence().preparations, 0);
  f.o.shellContinuous = false;
  assert.equal(f.c.evidence().shellContinuous, false);
});

test('rotation, touch and focus during traversal stop without later rearming', () => {
  for (const event of ['orientation', 'touch', 'focus']) {
    const f = fixture(); f.arm(); f.prepare();
    if (event === 'orientation') f.rotate();
    else { if (event === 'touch') f.o.touches = 1; else f.o.editable = true; f.tick(1, event); }
    Object.assign(f.o, { touches: 0, editable: false }); f.acknowledge(); f.settle();
    assert.equal(f.c.evidence().phase, 'stopped');
    assert.equal(f.count.rearm, 0);
  }
});

test('acknowledgment and original-scale timeouts do not retry', () => {
  for (const ack of [false, true]) {
    const f = fixture(); f.arm(); f.prepare();
    if (ack) { f.acknowledge(); f.o.scale = 2; f.o.width = 214; }
    f.tick(3100);
    assert.equal(f.c.evidence().reason, ack ? 'scale-timeout' : 'ack-timeout');
    assert.equal(f.c.evidence().phase, 'error');
    f.start(); f.release(); f.settle(); f.c.arm();
    assert.equal(f.count.back, 1);
    assert.equal(f.count.rearm, 0);
  }
});

test('history errors are explicit and a failed rearm is not a completed preparation', () => {
  for (const operation of ['checkpoint', 'back', 'rearm']) {
    const f = fixture();
    if (operation === 'checkpoint') { f.fail(operation); f.c.arm(); f.settle(); }
    else {
      f.arm(); f.start(); f.release(); f.fail(operation); f.settle();
      if (operation === 'rearm') { f.acknowledge(); f.settle(); }
    }
    assert.equal(f.c.evidence().phase, 'error');
    assert.equal(f.c.evidence().reason, 'history-error');
    assert.equal(f.c.evidence().preparations, 0);
    assert.equal(JSON.stringify(f.published()).includes('private detail'), false);
  }
});

test('unsafe initial state never writes a history checkpoint', () => {
  for (const change of [
    { historyLength: 2 }, { scale: 2 }, { width: null }, { scale: NaN },
    { overlay: true }, { editable: true }, { touches: 1 }, { scrollWidth: 1000 },
  ]) {
    const f = fixture(); Object.assign(f.o, change); f.c.arm(); f.settle();
    assert.equal(f.count.checkpoint, 0);
    assert.notEqual(f.c.evidence().reason, 'none');
  }
});

test('diagnostic counters stop explicitly before exceeding their bound', () => {
  const f = fixture(); f.arm();
  for (let i = 0; i < 1_000_001; i++) f.rotate();
  assert.equal(f.c.evidence().orientationEpoch, 1_000_000);
  assert.equal(f.c.evidence().phase, 'error');
  assert.equal(f.c.evidence().reason, 'counter-limit');
  assert.equal(f.count.back, 0);
});
