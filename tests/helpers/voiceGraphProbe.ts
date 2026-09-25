import type { Page } from '@playwright/test';

type Stage = { rate: number; channels: Float32Array[] };
export type EncodedStage = { rate: number; channels: string[] };
export type ProbeSnapshot = {
  stages: Partial<Record<'B' | 'C' | 'D' | 'E', EncodedStage>>;
  errors: string[]; chunkLengths: number[]; terminals: string[];
  recorderClosed: boolean;
  events: { kind: string; at: number; contextTime: number }[];
  nodes: { kind: string; channels: number; mode: string; interpretation: string }[];
};
type ProbeState = Omit<ProbeSnapshot, 'stages'> & {
  stages: Partial<Record<'B' | 'C' | 'D' | 'E', Stage>>;
  chunks: Float32Array[];
};
declare global {
  interface Window { __voiceGraphProbe?: ProbeState }
}

export async function installGraphProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__voiceGraphProbe) throw new Error('Probe already installed');
    const state: ProbeState = {
      stages: {}, chunks: [], errors: [], chunkLengths: [], terminals: [],
      recorderClosed: false, events: [], nodes: [],
    };
    window.__voiceGraphProbe = state;
    let recorder: BaseAudioContext | undefined;
    const observedSources = new WeakSet<AudioBufferSourceNode>();
    const event = (kind: string, context: BaseAudioContext) => {
      state.events.push({ kind, at: performance.now(), contextTime: context.currentTime });
    };
    const nodeMetadata = (kind: string, node: AudioNode) => {
      state.nodes.push({ kind, channels: node.channelCount,
        mode: node.channelCountMode, interpretation: node.channelInterpretation });
    };
    const copy = (key: 'B' | 'D' | 'E', buffer: AudioBuffer | null) => {
      if (!buffer || state.stages[key]) {
        state.errors.push(`missing_or_duplicate_${key}`);
        return;
      }
      state.stages[key] = { rate: buffer.sampleRate, channels: Array.from(
        { length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()) };
    };
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof nativeStart>) {
      if (observedSources.has(this)) state.errors.push('duplicate_source_start');
      observedSources.add(this);
      const kind = this.context instanceof OfflineAudioContext ? 'D' : 'B';
      if (this.context === recorder) state.errors.push('unexpected_recorder_buffer_source');
      copy(kind, this.buffer);
      event(`${kind}_start`, this.context);
      nodeMetadata(kind, this);
      return nativeStart.apply(this, args);
    };
    const nativeRender = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () {
      const result = nativeRender.call(this);
      void result.then(buffer => {
        copy('E', buffer);
        event('E_rendered', this);
      }, () => { state.errors.push('native_render_rejected'); });
      return result;
    };
    const nativeClose = AudioContext.prototype.close;
    AudioContext.prototype.close = function () {
      const result = nativeClose.call(this);
      void result.then(() => {
        if (this === recorder) state.recorderClosed = true;
        event('context_closed', this);
      }, () => { state.errors.push('native_close_rejected'); });
      return result;
    };
    const nativeMediaSource = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function (...args: Parameters<typeof nativeMediaSource>) {
      const result = nativeMediaSource.apply(this, args);
      nodeMetadata('media_source', result);
      return result;
    };
    const PreviousWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends PreviousWorklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== 'agents-chat-voice') return;
        if (recorder) state.errors.push('duplicate_recorder');
        recorder = context;
        state.stages.C = { rate: context.sampleRate, channels: [] };
        nodeMetadata('worklet', this);
        event('worklet_created', context);
        this.port.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
          if (!data || typeof data !== 'object' || !('type' in data)) {
            state.errors.push('invalid_worklet_message');
          } else if (data.type === 'samples' && 'samples' in data && data.samples instanceof Float32Array) {
            if (state.terminals.length) state.errors.push('samples_after_terminal');
            state.chunks.push(data.samples.slice());
            state.chunkLengths.push(data.samples.length);
            event('chunk', context);
          } else if (data.type === 'finished' || data.type === 'limit') {
            state.terminals.push(data.type);
            event(data.type, context);
          } else state.errors.push('unknown_worklet_message');
        });
      }
    };
  });
}

export async function graphSnapshot(page: Page): Promise<ProbeSnapshot | null> {
  return page.evaluate(() => {
    const state = window.__voiceGraphProbe;
    if (!state) return null;
    const stages: ProbeSnapshot['stages'] = {};
    for (const key of ['B', 'C', 'D', 'E'] as const) {
      const stage = state.stages[key];
      if (!stage) continue;
      let channels = stage.channels;
      if (key === 'C') {
        const joined = new Float32Array(state.chunkLengths.reduce((sum, n) => sum + n, 0));
        let offset = 0;
        for (const chunk of state.chunks) { joined.set(chunk, offset); offset += chunk.length; }
        channels = [joined];
      }
      stages[key] = { rate: stage.rate, channels: channels.map(samples => {
        const bytes = new Uint8Array(samples.length * 4);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
        let encoded = '';
        for (let start = 0; start < bytes.length; start += 8192) {
          encoded += String.fromCharCode(...bytes.subarray(start, start + 8192));
        }
        return btoa(encoded);
      }) };
    }
    return { stages, errors: state.errors, chunkLengths: state.chunkLengths,
      terminals: state.terminals, recorderClosed: state.recorderClosed, events: state.events, nodes: state.nodes };
  });
}
