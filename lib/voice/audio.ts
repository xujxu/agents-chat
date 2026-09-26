export const VOICE_SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 30;
export const MAX_VOICE_BYTES = 44 + VOICE_SAMPLE_RATE * MAX_VOICE_SECONDS * 2;

export class VoiceError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export function encodeVoiceWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  if (!samples.length) throw new VoiceError('voice_no_audio', 422);
  if (samples.length > VOICE_SAMPLE_RATE * MAX_VOICE_SECONDS) throw new VoiceError('voice_too_long', 413);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    bytes.set(new TextEncoder().encode(text), offset);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new VoiceError('voice_invalid_audio', 400);
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function validateVoiceWav(bytes: Uint8Array): { durationSeconds: number } {
  if (bytes.length > MAX_VOICE_BYTES) throw new VoiceError('voice_too_large', 413);
  const invalid = () => { throw new VoiceError('voice_invalid_audio', 400); };
  if (bytes.length < 46 || bytes.length % 2 !== 0) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    if (new TextDecoder().decode(bytes.subarray(offset, offset + 4)) !== text) invalid();
  }
  if (view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== VOICE_SAMPLE_RATE || view.getUint32(28, true) !== VOICE_SAMPLE_RATE * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44) invalid();
  let peak = 0;
  for (let offset = 44; offset < bytes.length; offset += 2) peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  if (peak <= 16) throw new VoiceError('voice_no_speech', 422);
  return { durationSeconds: (bytes.length - 44) / (VOICE_SAMPLE_RATE * 2) };
}
