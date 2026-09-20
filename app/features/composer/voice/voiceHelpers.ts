export function appendVoiceTranscript(input: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return input;
  return input + (input && !/\s$/.test(input) ? '\n' : '') + text;
}

export function voiceErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow it in your browser and try again.';
  }
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    voice_busy: 'Voice transcription is busy. Please try again shortly.',
    voice_low_memory: 'The server has insufficient free memory for voice input. Please try again later.',
    voice_memory_limit: 'Voice input stopped to protect server memory. Please try again later.',
    voice_timeout: 'Voice transcription timed out. Try a shorter recording.',
    voice_no_audio: 'No audio was recorded. Please try again.',
    voice_no_speech: 'No speech was detected. Please try again.',
    voice_too_large: 'The recording exceeds the 30-second voice limit.',
    voice_too_long: 'The recording exceeds the 30-second voice limit.',
    voice_disabled: 'Voice input is disabled on this server.',
    voice_account_changed: 'Your account changed. Please record again.',
    voice_not_configured: 'Voice input is not configured correctly on this server.',
    voice_unsupported_browser: 'This browser does not support the microphone features required for voice input.',
  };
  return messages[code] || 'Voice input failed. Your existing text is unchanged; please try again.';
}
