'use client';

import type { useVoiceInput } from './useVoiceInput';
import './VoiceInput.css';

type Props = { voice: ReturnType<typeof useVoiceInput> };

export function VoiceInputControls({ voice }: Props) {
  if (!voice.available) return null;
  const recording = voice.phase === 'recording';
  const busy = voice.phase !== 'idle';
  return (
    <div className="voiceControls">
      <button
        type="button"
        className={`voiceButton${recording ? ' voiceRecording' : ''}`}
        aria-label={recording ? 'Stop recording' : 'Start voice input'}
        title={recording ? 'Stop recording and transcribe' : 'Voice input (up to 30 seconds)'}
        aria-pressed={recording}
        disabled={busy && !recording}
        onClick={() => { if (recording) void voice.stop(); else void voice.start(); }}
      >
        {recording ? <span className="voiceStopIcon" aria-hidden="true" /> : (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="9" y="2" width="6" height="13" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
        )}
      </button>
      {busy ? <button className="voiceButton" type="button" onClick={voice.cancel} aria-label="Cancel voice input" title="Cancel voice input">×</button> : null}
    </div>
  );
}

export function VoiceInputStatus({ voice }: Props) {
  if (voice.error) return (
    <div className="voiceStatus voiceError" role="alert">
      <span>{voice.error}</span>
      <button type="button" onClick={voice.dismissError} aria-label="Dismiss voice error">×</button>
    </div>
  );
  if (voice.phase === 'idle') return null;
  const text = voice.phase === 'recording'
    ? `Recording 0:${String(voice.seconds).padStart(2, '0')} / 0:30`
    : voice.phase === 'preparing' ? 'Opening microphone…' : 'Transcribing…';
  return <div className="voiceStatus" role="status"><span className={voice.phase === 'recording' ? 'voiceLiveDot' : 'voiceBusyDot'} aria-hidden="true" /><span>{text}</span></div>;
}
