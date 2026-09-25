import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCapability, assertDelivery, expectedRecords, validateHost } from '../scripts/voice/lifecycle-contract.ts';

const valid = () => ({
  status: 200, body: { ok: true, text: 'Recognized words', elapsedMs: 1 },
  draft: 'Keep my draft', composer: 'Keep my draft\nRecognized words', sends: 0,
  sourceCompleted: true, tracksStopped: true, contextClosed: true,
  uploadBytes: 100, idle: true, requestCount: 1,
});
test('real response and draft are equal without imposing reference accuracy', () => {
  assertDelivery(valid());
  assertDelivery({ ...valid(), body: { ok: true, text: 'different words', elapsedMs: 2 },
    composer: 'Keep my draft\ndifferent words' });
});
test('invalid response and incomplete delivery cannot pass', () => {
  for (const changed of [
    { status: 500 }, { body: { ok: true, text: '', elapsedMs: 1 } },
    { body: { ok: false, error: 'failed' } }, { body: null },
    { body: { ok: true, text: 'bad\0text', elapsedMs: 1 } },
    { composer: 'Recognized words' }, { composer: valid().composer + '\nRecognized words' },
    { sends: 1 }, { requestCount: 0 }, { requestCount: 2 }, { uploadBytes: 44 },
    { sourceCompleted: false }, { tracksStopped: false }, { contextClosed: false }, { idle: false },
  ]) assert.throws(() => assertDelivery({ ...valid(), ...changed }));
});
test('capabilities must reflect actual requested lifecycle state', () => {
  const enabled = { ok: true, enabled: true, model: 'sensevoice-small-q8', provider: 'sensevoice-gguf',
    resourcePolicy: 'standard', threads: 2, maxSeconds: 30 };
  assertCapability(enabled, true);
  assertCapability({ ok: true, enabled: false, model: null, provider: null, threads: null, maxSeconds: 30 }, false);
  for (const changed of [{ enabled: false }, { model: 'mock' }, { threads: 1 }, { ok: false }]) {
    assert.throws(() => assertCapability({ ...enabled, ...changed }, true));
  }
});
test('fixed host/project coverage and missing lifecycle phases fail closed', () => {
  assert.equal(expectedRecords('linux').length, 12);
  assert.equal(expectedRecords('win32').length, 4);
  assert.throws(() => expectedRecords('darwin'));
  assert.throws(() => validateHost({ platform: 'linux', run: '1', commit: 'abc', phases: [], records: [] }, '1', 'abc'));
});
