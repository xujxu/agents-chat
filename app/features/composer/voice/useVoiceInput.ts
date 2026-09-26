'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_VOICE_SECONDS } from '@/lib/voice/audio';
import { startVoiceRecording, type VoiceRecording } from './voiceRecorder';
import { voiceErrorMessage } from './voiceHelpers';

export type VoicePhase = 'idle' | 'preparing' | 'recording' | 'transcribing';
type VoiceJob = {
  scope: string; userId: string; controller: AbortController; recording?: VoiceRecording;
  requestId?: string; phase: VoicePhase;
};
type Options = { userId: string; chatId: string; active: boolean; onTranscript: (text: string) => void };

export function useVoiceInput({ userId, chatId, active, onTranscript }: Options) {
  const scope = JSON.stringify([userId, chatId, active]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const jobRef = useRef<VoiceJob | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const isCurrent = useCallback((job: VoiceJob) =>
    jobRef.current === job && job.scope === scopeRef.current && !job.controller.signal.aborted, []);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    jobRef.current = null;
    job?.controller.abort();
    if (job?.requestId) {
      void fetch('/api/voice', {
        method: 'DELETE', keepalive: true,
        headers: { 'x-voice-user-id': job.userId, 'x-voice-request-id': job.requestId },
      }).then(response => {
        if (!response.ok) console.error('Voice server cancellation failed:', response.status);
      }, () => console.error('Voice server cancellation failed: network error'));
    }
    setPhase('idle');
    setSeconds(0);
  }, []);

  useEffect(() => {
    setAvailable(false);
    setError(null);
    if (!active || !chatId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/voice', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('voice_not_configured');
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('enabled' in result) || typeof result.enabled !== 'boolean') {
          throw new Error('voice_invalid_result');
        }
        if (controller.signal.aborted) return;
        if (result.enabled && (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode || !window.OfflineAudioContext)) {
          throw new Error('voice_unsupported_browser');
        }
        setAvailable(result.enabled);
      } catch (failure) {
        if (!controller.signal.aborted) setError(voiceErrorMessage(failure));
      }
    })();
    return () => { controller.abort(); cancel(); };
  }, [scope, active, chatId, cancel]);

  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    const pageHide = () => cancel();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', pageHide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pageHide);
    };
  }, [cancel]);

  const stop = useCallback(async () => {
    const job = jobRef.current;
    if (!job || job.phase !== 'recording' || !job.recording || !isCurrent(job)) return;
    job.phase = 'transcribing';
    setPhase('transcribing');
    const deadline = setTimeout(() => {
      if (isCurrent(job)) { setError(voiceErrorMessage(new Error('voice_timeout'))); cancel(); }
    }, 130_000);
    try {
      const audio = await job.recording.finish();
      if (!isCurrent(job)) return;
      job.requestId = crypto.randomUUID();
      const response = await fetch('/api/voice', {
        method: 'POST', signal: job.controller.signal, body: audio,
        headers: { 'content-type': 'audio/wav', 'x-voice-user-id': job.userId, 'x-voice-request-id': job.requestId },
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const code = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'voice_failed';
        throw new Error(code);
      }
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error('voice_no_speech');
      }
      if (isCurrent(job)) onTranscript(result.text);
    } catch (failure) {
      if (isCurrent(job)) { setError(voiceErrorMessage(failure)); cancel(); }
    } finally {
      clearTimeout(deadline);
      if (jobRef.current === job) { jobRef.current = null; setPhase('idle'); }
    }
  }, [isCurrent, onTranscript, cancel]);
  stopRef.current = () => { void stop(); };

  const start = useCallback(async () => {
    if (!available || !active || jobRef.current) return;
    const job: VoiceJob = { scope, userId, controller: new AbortController(), phase: 'preparing' };
    jobRef.current = job;
    setError(null);
    setSeconds(0);
    setPhase('preparing');
    try {
      job.recording = await startVoiceRecording(job.controller.signal, () => stopRef.current());
      if (!isCurrent(job)) { await job.recording.cancel(); return; }
      job.phase = 'recording';
      setPhase('recording');
    } catch (failure) {
      if (isCurrent(job)) {
        setError(voiceErrorMessage(failure));
        jobRef.current = null;
        setPhase('idle');
      }
    }
  }, [active, available, scope, userId, isCurrent]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = performance.now();
    const clock = setInterval(() => setSeconds(Math.min(MAX_VOICE_SECONDS, Math.floor((performance.now() - started) / 1000))), 200);
    const limit = setTimeout(() => stopRef.current(), MAX_VOICE_SECONDS * 1000);
    return () => { clearInterval(clock); clearTimeout(limit); };
  }, [phase]);

  return { available, phase, error, seconds, start, stop, cancel, dismissError: () => setError(null) };
}
