import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { instrumentController, restoreController, controllerSha } from './helpers/instrumentScrollController.mjs';
import { initializeControllerDiagnostics, requireCompleteReport } from './helpers/controllerStateRecorder.ts';

test('instrumentation is pinned, reversible and rejects missing/duplicated sites', async () => {
  assert.ok(process.env.DIAGNOSTIC_CONTROLLER_SOURCE, 'Pinned controller source is required');
  const source = await readFile(process.env.DIAGNOSTIC_CONTROLLER_SOURCE, 'utf8');
  const output = instrumentController(source);
  assert.notEqual(output, source);
  assert.equal(restoreController(output), source);
  assert.doesNotThrow(() => stripTypeScriptTypes(output));
  assert.equal(createHash('sha256').update(source).digest('hex'), controllerSha);
  assert.throws(() => instrumentController(source + '\n'), /revision/);
  assert.throws(() => instrumentController(source.replace('function onScroll()', 'function other()')), /revision/);
  assert.throws(() => instrumentController(source + source), /revision/);
  assert.throws(() => instrumentController(output), /revision/);
  for (const event of ['correct:independent', 'scroll:independent', 'resize:callback', 'capture:complete', 'write:complete']) {
    assert.ok(output.includes(`'${event}'`), event);
  }
});

function withRecorder(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try {
    initializeControllerDiagnostics();
    run(window.__chatScrollDiagnostic);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function state() {
  return {
    following: true, userIntent: false, jumping: false, suspended: false,
    disposed: false, multiTouch: false, scrollbarDrag: false, correctionPending: false,
    anchorPresent: false, expectedTop: null, lastTop: 100,
    cached: { width: 844, height: 184, contentHeight: 284 },
    current: { width: 844, height: 179, contentHeight: 284 }, scrollTop: 100,
  };
}

test('state recorder preserves value snapshots, order, time and controller identities', () => {
  withRecorder(recorder => {
    const value = state();
    recorder.record(recorder.nextId++, 'correct:enter', () => value);
    value.following = false;
    value.cached.height = 179;
    recorder.record(recorder.nextId++, 'capture:complete', () => value);
    const [first, second] = recorder.report.events;
    assert.equal(first.state.following, true);
    assert.equal(first.state.cached.height, 184);
    assert.equal(second.state.following, false);
    assert.deepEqual([first.controller, second.controller], [1, 2]);
    assert.deepEqual([first.sequence, second.sequence], [0, 1]);
    assert.ok(Number.isFinite(first.at) && second.at >= first.at);
    requireCompleteReport(recorder.report);
  });
});

test('state history has exactly 2048 slots and stops reading after saturation', () => {
  withRecorder(recorder => {
    let reads = 0;
    for (let index = 0; index < 2051; index++) {
      recorder.record(1, 'schedule:enter', () => { reads++; return state(); });
    }
    assert.equal(reads, 2048);
    assert.equal(recorder.report.events.length, 2048);
    assert.equal(recorder.report.dropped, 3);
    assert.throws(() => requireCompleteReport(recorder.report), /incomplete/);
  });
});

test('capture errors are bounded, named and cannot become complete evidence', () => {
  withRecorder(recorder => {
    recorder.record(1, 'correct:enter', state);
    for (let index = 0; index < 19; index++) {
      recorder.record(1, 'read:error', () => { throw new TypeError('do not retain private content'); });
    }
    assert.equal(recorder.report.errors.length, 16);
    assert.equal(recorder.report.errorsDropped, 3);
    assert.ok(recorder.report.errors.every(error => error === 'TypeError'));
    assert.ok(!JSON.stringify(recorder.report).includes('private content'));
    assert.throws(() => requireCompleteReport(recorder.report), /incomplete/);
  });
});

test('missing, empty and malformed evidence fails explicitly', () => {
  for (const report of [undefined, null, {}, { events: [] }]) {
    assert.throws(() => requireCompleteReport(report));
  }
  withRecorder(recorder => {
    assert.throws(() => requireCompleteReport(recorder.report), /empty/);
    recorder.record(1, 'correct:enter', state);
    for (const change of [
      report => { report.events[0].state.following = 'yes'; },
      report => { report.events[0].state.current.height = null; },
      report => { report.events[0].sequence = 12; },
      report => { report.events[0].at = NaN; },
      report => { report.events[0].controller = 0; },
      report => { report.dropped = -1; },
    ]) {
      const report = structuredClone(recorder.report);
      change(report);
      assert.throws(() => requireCompleteReport(report), /Malformed/);
    }
  });
});
