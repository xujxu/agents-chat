import { encodeVoiceWav, MAX_VOICE_SECONDS, VOICE_SAMPLE_RATE } from '@/lib/voice/audio';

export type VoiceRecording = { finish: () => Promise<Blob>; cancel: () => Promise<void> };

export async function startVoiceRecording(signal: AbortSignal, onLimit: () => void): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) {
    throw new Error('voice_unsupported_browser');
  }
  const context = new AudioContext();
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let closing: Promise<void> | undefined;
  let finishCapture: (() => void) | undefined;
  const chunks: Float32Array[] = [];
  let sampleCount = 0;
  const maximumSamples = Math.floor(context.sampleRate * MAX_VOICE_SECONDS);
  const cleanup = () => {
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    source?.disconnect();
    node?.disconnect();
    signal.removeEventListener('abort', onAbort);
    return closing ??= context.state === 'closed' ? Promise.resolve() : context.close();
  };
  const onAbort = () => {
    finishCapture?.();
    void cleanup().catch(() => console.error('Voice microphone cleanup failed'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    signal.throwIfAborted();
    await context.audioWorklet.addModule('/voice/recorder-worklet.js');
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, 'agents-chat-voice', { processorOptions: { maxSeconds: MAX_VOICE_SECONDS } });
    node.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array }>) => {
      if (signal.aborted) return;
      if (data.type === 'samples' && data.samples instanceof Float32Array) {
        const samples = data.samples.subarray(0, Math.max(0, maximumSamples - sampleCount));
        chunks.push(samples);
        sampleCount += samples.length;
      } else if (data.type === 'limit') onLimit();
      else if (data.type === 'finished') finishCapture?.();
    };
    source = context.createMediaStreamSource(stream);
    const muted = context.createGain();
    muted.gain.value = 0;
    source.connect(node);
    node.connect(muted);
    muted.connect(context.destination);
    return {
      cancel: cleanup,
      async finish() {
        try {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('voice_capture_timeout')), 2000);
            finishCapture = () => { clearTimeout(timer); resolve(); };
            node!.port.postMessage('stop');
          });
          signal.throwIfAborted();
          await cleanup();
          if (!sampleCount) throw new Error('voice_no_audio');
          const samples = new Float32Array(sampleCount);
          let offset = 0;
          for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
          const length = Math.min(VOICE_SAMPLE_RATE * MAX_VOICE_SECONDS, Math.ceil(sampleCount * VOICE_SAMPLE_RATE / context.sampleRate));
          const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
          const buffer = offline.createBuffer(1, sampleCount, context.sampleRate);
          buffer.copyToChannel(samples, 0);
          const player = offline.createBufferSource();
          player.buffer = buffer;
          player.connect(offline.destination);
          player.start();
          const rendered = await offline.startRendering();
          signal.throwIfAborted();
          return new Blob([encodeVoiceWav(rendered.getChannelData(0))], { type: 'audio/wav' });
        } finally { await cleanup(); }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
