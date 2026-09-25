import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { collectGraph } from './helpers/voiceGraphCollector';
import { graphSchedule, graphWav } from './helpers/voiceGraphStimuli';
import { installGraphProbe } from './helpers/voiceGraphProbe';

test('graph contracts: deterministic canonical stimuli and independent values', () => {
  const mono = graphWav('mono-tones');
  expect(mono.length).toBe(256044);
  expect(mono.readUInt16LE(22)).toBe(1);
  expect(mono.readUInt32LE(24)).toBe(16000);
  expect(mono.subarray(44, 44 + 16000).every(value => value === 0)).toBe(true);
  expect(mono.equals(graphWav('mono-tones'))).toBe(true);
  const stereo = graphWav('stereo-tones');
  expect(stereo.readUInt16LE(22)).toBe(2);
  expect(stereo.length).toBe(512044);
  expect(stereo.readInt16LE(44 + 8008 * 4)).toBe(3277);
  expect(stereo.readInt16LE(46 + 8008 * 4)).toBe(-1966);
  const markers = graphWav('mono-markers');
  expect(markers.readInt16LE(44 + 16004 * 2)).toBe(3932);
  expect(markers.readInt16LE(44 + 64004 * 2)).toBe(1311);
  expect(graphSchedule.length).toBe(18);
  expect(graphSchedule.slice(0, 6).map(row => row.mode)).toEqual(['minimal', 'full', 'full', 'minimal', 'minimal', 'full']);
});

test('graph contracts: native promise, arguments and errors stay visible', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const original = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () {
      const pending = original.call(this);
      Object.defineProperty(this, '__originalPromise', { value: pending });
      return pending;
    };
  });
  await installGraphProbe(page);
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 1600, 16000);
    const source = context.createBufferSource();
    const buffer = context.createBuffer(1, 800, 16000);
    buffer.getChannelData(0).fill(.125);
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(.025);
    let nativeError = '';
    try { source.start(); } catch (error) { nativeError = error instanceof DOMException ? error.name : 'wrong_error'; }
    const pending = context.startRendering();
    const identical = pending === Object.getOwnPropertyDescriptor(context, '__originalPromise')?.value;
    const rendered = await pending;
    const state = window.__voiceGraphProbe!;
    const copied = state.stages.D!.channels[0];
    copied[0] = .75;
    return { identical, nativeError, original: buffer.getChannelData(0)[0],
      before: rendered.getChannelData(0)[300], after: rendered.getChannelData(0)[500],
      errors: state.errors };
  });
  expect(result).toMatchObject({ identical: true, nativeError: 'InvalidStateError', original: .125, before: 0, after: .125 });
  expect(result.errors).toContain('duplicate_source_start');
});

test('graph contracts: original recorder chunks and offline input agree', async ({ page }, info) => {
  const row = await collectGraph(page, info, 'mono-tones', 0, 'full', false);
  const c = row.C as { channels: { file: string }[] };
  const d = row.D as { channels: { file: string }[] };
  expect(readFileSync(`graph-contract-evidence/${c.channels[0].file}`).equals(
    readFileSync(`graph-contract-evidence/${d.channels[0].file}`))).toBe(true);
});

for (const { stimulus, repeat, mode } of graphSchedule) {
  test(`graph measurement: ${stimulus}/${repeat}/${mode}`, async ({ page }, info) => {
    test.skip(process.env.VOICE_GRAPH_MEASURE !== '1', 'Explicit Actions-only measurement required');
    await collectGraph(page, info, stimulus, repeat, mode, true);
  });
}
