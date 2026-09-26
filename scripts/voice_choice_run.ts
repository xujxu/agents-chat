import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { transcribeVoice } from '../lib/voice/transcriber';
import { validateVoiceWav } from '../lib/voice/audio';

type Sample = {
  id: string; reference: string; category: string; duration: number;
  split: string; audio_sha256: string;
};
async function main() {
  const [source, variant, output] = process.argv.slice(2);
  if (!source || !output || !/^(whisper|whole|segment-[235])$/.test(variant)) throw new Error('Invalid benchmark arguments');
  const samples: Sample[] = JSON.parse(await readFile(`${source}/samples.json`, 'utf8'));
  const configuration = variant === 'whisper'
    ? { binary: path.resolve('native/runtime/whisper-cli'), model: path.resolve('native/runtime/ggml-base-q5_1.bin') }
    : { binary: path.resolve(`voice-sense-${variant}`), model: path.resolve('sense/model.int8.onnx') };
  await mkdir(output, { recursive: true });
  await mkdir('chain-evidence', { recursive: true });
  await writeFile(`${output}/results.jsonl`, '');
  for (const sample of samples) {
    const audio = await readFile(`${source}/audio/${sample.id}.wav`);
    if (createHash('sha256').update(audio).digest('hex') !== sample.audio_sha256) throw new Error('Audio changed');
    validateVoiceWav(audio);
    await writeFile('chain-evidence/native-metrics.jsonl', '');
    let failure: string | null = null;
    let text: string | null = null;
    const started = performance.now();
    try {
      text = await transcribeVoice(audio, configuration, AbortSignal.timeout(120_000));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!error.message.startsWith('voice_') && error.name !== 'TimeoutError') throw error;
      failure = error.name === 'TimeoutError' ? 'voice_timeout' : error.message;
    }
    const seconds = (performance.now() - started) / 1000;
    const metrics = (await readFile('chain-evidence/native-metrics.jsonl', 'utf8')).trim();
    const native: { peak_rss_kib: number; segments: number } | null = metrics ? JSON.parse(metrics) : null;
    await appendFile(`${output}/results.jsonl`, JSON.stringify({
      ...sample, variant, text, failure, seconds, peak_rss_kib: native?.peak_rss_kib ?? null,
      segments: native?.segments ?? null,
    }) + '\n');
    console.log(JSON.stringify({ id: sample.id, variant, failure, seconds }));
  }
  await writeFile(`${output}/complete.json`, JSON.stringify({
    variant, count: samples.length, commit: process.env.GITHUB_SHA,
    scope: 'Actual transcribeVoice with fixed memory guard. Excludes HTTP/browser overhead.',
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
