import { VoiceError } from './audio';

type ActiveJob = { key: string; controller: AbortController };
type VoiceState = { active: ActiveJob | null; cancelled: Map<string, number> };
const globalVoice = globalThis as typeof globalThis & { __voicePocJobs?: VoiceState };
const state = globalVoice.__voicePocJobs ??= { active: null, cancelled: new Map() };
const TIMEOUT_MS = 120_000;

function pruneCancelled() {
  for (const [key, expires] of state.cancelled) if (expires <= Date.now()) state.cancelled.delete(key);
}

export function cancelVoiceJob(userId: string, requestId: string) {
  pruneCancelled();
  const key = JSON.stringify([userId, requestId]);
  if (state.active?.key === key) state.active.controller.abort(new VoiceError('voice_cancelled', 499));
  // Remember early cancellation when DELETE overtakes a pending upload.
  if (!state.cancelled.has(key) && state.cancelled.size >= 64) throw new VoiceError('voice_busy', 429);
  state.cancelled.set(key, Date.now() + TIMEOUT_MS);
}

export function reserveVoiceJob(userId: string, requestId: string, requestSignal: AbortSignal) {
  pruneCancelled();
  const key = JSON.stringify([userId, requestId]);
  if (requestSignal.aborted || state.cancelled.has(key)) throw new VoiceError('voice_cancelled', 499);
  if (state.active) throw new VoiceError('voice_busy', 429);
  const controller = new AbortController();
  const job = { key, controller };
  state.active = job;
  const onAbort = () => controller.abort(new VoiceError('voice_cancelled', 499));
  requestSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new VoiceError('voice_timeout', 504)), TIMEOUT_MS);
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', onAbort);
      if (state.active === job) state.active = null;
    },
  };
}
