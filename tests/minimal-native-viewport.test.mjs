import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMAL_METRICS, validateMinimalViewportLog,
} from '../lib/viewportReproduction/schema.ts';
import { createMinimalRecorder } from '../lib/viewportReproduction/recorder.ts';
import { renderMinimalViewportHtml } from '../lib/viewportReproduction/html.ts';

function sample(t = 0, events = ['initial']) {
  return {
    t, events, touches: 0, orientation: 'portrait', visibility: 'visible',
    metrics: Object.fromEntries(MINIMAL_METRICS.map(key => [key, key === 'scale' ? 1 : 428])),
  };
}

function seed() {
  return {
    version: 1, experiment: 'native-viewport-minimal', browser: 'chrome',
    browserVersion: '153.0.8010.24', osVersion: '18.7.8',
    clientRevision: 'a'.repeat(40), initial: sample(),
  };
}

function log() {
  return { ...seed(), samples: [sample(300, ['stop'])], dropped: 0, stopReason: 'manual' };
}

test('minimal contract is exact, chronological and distinct from chat evidence', () => {
  assert.equal(validateMinimalViewportLog(log()), true);
  for (const invalid of [
    { ...log(), version: 5 }, { ...log(), experiment: 'native-history-preventive' },
    { ...log(), url: 'private' }, { ...log(), clientRevision: 'private' },
    { ...log(), browserVersion: 'private' }, { ...log(), dropped: -1 },
    { ...log(), dropped: 0.5 }, { ...log(), stopReason: 'unknown' },
    { ...log(), initial: sample(1) },
    { ...log(), samples: [sample(300, ['stop']), sample(200, ['periodic'])] },
    { ...log(), samples: [sample(300, ['periodic'])] },
    { ...log(), samples: Array.from({ length: 256 }, (_, i) => sample(i, ['stop'])) },
    ...[
      { touches: 21 }, { touches: -1 }, { events: ['unknown'] }, { events: ['stop', 'stop'] },
      { visibility: 'private' }, { orientation: 'private' }, { probe: {} },
      { metrics: { ...sample().metrics, scale: Infinity } },
      { metrics: { ...sample().metrics, private: 1 } },
    ].map(change => ({ ...log(), samples: [{ ...sample(300, ['stop']), ...change }] })),
  ]) assert.equal(validateMinimalViewportLog(invalid), false, JSON.stringify(invalid));
});

test('unavailable measurements remain null and lifecycle reasons must match final events', () => {
  const nullable = log();
  nullable.samples[0].metrics.scale = null;
  assert.equal(validateMinimalViewportLog(nullable), true);
  for (const [reason, event] of [['timeout', 'timeout'], ['hidden', 'hidden'], ['pagehide', 'pagehide']]) {
    const candidate = { ...log(), stopReason: reason, samples: [sample(300, [event])] };
    if (reason === 'hidden') candidate.samples[0].visibility = 'hidden';
    assert.equal(validateMinimalViewportLog(candidate), true);
    assert.equal(validateMinimalViewportLog({ ...log(), stopReason: reason }), false);
  }
});

test('recorder bounds total samples including initial and freezes body across later calls', () => {
  const recorder = createMinimalRecorder(seed());
  for (let i = 1; i <= 299; i++) recorder.record(sample(i, ['periodic']));
  recorder.record(sample(300, ['stop']));
  const first = recorder.finish('manual');
  assert.equal(first.log.initial.t, 0);
  assert.equal(first.log.samples.length, 255);
  assert.equal(first.log.samples[0].t, 46);
  assert.equal(first.log.dropped, 45);
  assert.equal(first.log.samples.at(-1).t, 300);
  assert.equal(validateMinimalViewportLog(first.log), true);
  recorder.record(sample(301, ['periodic']));
  assert.equal(recorder.finish('timeout').body, first.body);
  assert.ok(Buffer.byteLength(first.body) <= 256 * 1024);
});

test('recorder clones input and preserves exact native readings within byte budget', () => {
  const original = seed();
  const recorder = createMinimalRecorder(original);
  original.initial.metrics.scale = 99;
  for (let i = 1; i <= 255; i++) {
    const item = sample(i, i === 255 ? ['stop'] : ['periodic']);
    for (const key of MINIMAL_METRICS) item.metrics[key] = 123456.78901234567;
    item.metrics.scale = 2.018817186355591;
    recorder.record(item);
    item.metrics.scale = 99;
  }
  const { log: frozen, body } = recorder.finish('manual');
  assert.equal(frozen.initial.metrics.scale, 1);
  assert.equal(frozen.samples.at(-1).metrics.scale, 2.018817186355591);
  assert.ok(Buffer.byteLength(body) <= 256 * 1024);
  assert.equal(frozen.samples.length + frozen.dropped, 255);
});

test('HTML has no framework resources, preserves typography and rejects unsafe revision', () => {
  const html = renderMinimalViewportHtml('b'.repeat(40));
  assert.match(html, /data-revision="b{40}"/);
  assert.match(html, /-webkit-text-size-adjust:\s*100%/);
  assert.match(html, /(?:^|[;\s])text-size-adjust:\s*100%/);
  assert.match(html, /width=device-width, initial-scale=1, interactive-widget=resizes-content/);
  assert.doesNotMatch(html, /__next|\/_next\/|script\s+src=|stylesheet|maximum-scale|minimum-scale|user-scalable/i);
  assert.throws(() => renderMinimalViewportHtml('"><script>private</script>'), /revision/i);
});
