import type { Page } from '@playwright/test';

export type BrowserTiming = {
  stopAt: number | null; workletStopAt: number | null; fetchAt: number | null;
  bodyAt: number | null; composerAt: number | null; terminalAt: number | null;
  stopKind: 'manual' | 'automatic' | null;
};
export type BrowserCaptureSnapshot = {
  uploadBase64: string | null; status: number | null; body: unknown;
  observerError: string | null; fetchFailure: string | null; composerText: string | null;
  timing: BrowserTiming;
  capture: {
    sourceRate: number | null; recorderRate: number | null; sourceCompleted: boolean;
    sourceStartedAt: number | null; sourceEndedAt: number | null;
    tracksStopped: boolean; contextClosed: boolean;
  };
};
type BrowserCaptureState = BrowserCaptureSnapshot & {
  sourceBase64: string; active: boolean; play?: () => void;
};
declare global {
  interface Window { __installedVoiceCapture?: BrowserCaptureState }
}

export async function installBrowserCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ownedTracks = new Map<string, () => void>();
    const nativeStop = MediaStreamTrack.prototype.stop;
    // WebKit can return different JS wrappers for the same native track.
    MediaStreamTrack.prototype.stop = function () {
      nativeStop.call(this);
      const cleanup = ownedTracks.get(this.id);
      if (cleanup) {
        ownedTracks.delete(this.id);
        cleanup();
      }
    };
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const pending = nativeFetch.call(window, input, init);
      const state = window.__installedVoiceCapture;
      if (state?.active && input === '/api/voice' && init?.method === 'POST' && init.body instanceof Blob) {
        state.timing.fetchAt = performance.now();
        void init.body.arrayBuffer().then(buffer => {
          let encoded = '';
          for (const byte of new Uint8Array(buffer)) encoded += String.fromCharCode(byte);
          state.uploadBase64 = btoa(encoded);
        }, () => { state.observerError = 'upload_copy_failed'; });
        void pending.then(response => {
          state.status = response.status;
          return response.clone().json().then((body: unknown) => {
            state.body = body;
            state.timing.bodyAt = performance.now();
          }, () => { state.observerError = 'invalid_api_body'; });
        }, () => { state.fetchFailure = 'transport_error'; });
      }
      return pending;
    };
    document.addEventListener('click', event => {
      const state = window.__installedVoiceCapture;
      if (state?.active && event.target instanceof Element
        && event.target.closest('button')?.getAttribute('aria-label') === 'Stop recording') {
        state.timing.stopAt ??= performance.now();
        state.timing.stopKind = 'manual';
      }
    }, true);
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        const state = window.__installedVoiceCapture;
        if (name !== 'agents-chat-voice' || !state?.active) return;
        state.capture.recorderRate = context.sampleRate;
        const original = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) => {
          if (message === 'stop') {
            state.timing.workletStopAt = performance.now();
            if (state.timing.stopAt === null) {
              state.timing.stopAt = state.timing.workletStopAt;
              state.timing.stopKind = 'automatic';
            }
          }
          if (Array.isArray(transfer)) original(message, transfer);
          else original(message, transfer);
        };
      }
    };
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), 'getUserMedia', {
      configurable: true,
      value: async () => {
        const state = window.__installedVoiceCapture;
        if (!state?.active) throw new Error('Capture was not armed');
        const context = new AudioContext({ sampleRate: 48000 });
        state.capture.sourceRate = context.sampleRate;
        const bytes = Uint8Array.from(atob(state.sourceBase64), char => char.charCodeAt(0));
        let buffer: AudioBuffer;
        try {
          buffer = await context.decodeAudioData(bytes.buffer);
        } catch (error) {
          await context.close();
          state.capture.contextClosed = true;
          throw error;
        }
        const destination = context.createMediaStreamDestination();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        await context.resume();
        let startTime: number | null = null;
        const complete = () => startTime !== null && context.currentTime + 1 / context.sampleRate >= startTime + buffer.duration;
        source.onended = () => {
          state.capture.sourceEndedAt = performance.now();
          state.capture.sourceCompleted = complete();
        };
        state.play = () => {
          if (startTime !== null) throw new Error('Source may play only once');
          startTime = context.currentTime;
          state.capture.sourceStartedAt = performance.now();
          source.start();
        };
        for (const track of destination.stream.getTracks()) {
          ownedTracks.set(track.id, () => {
            state.capture.sourceCompleted = complete();
            state.capture.tracksStopped = true;
            if (startTime !== null) source.stop();
            void context.close().then(() => { state.capture.contextClosed = true; },
              () => { state.observerError = 'source_context_cleanup_failed'; });
          });
        }
        return destination.stream;
      },
    });
  });
}

export async function armBrowserCapture(page: Page, sourceBase64: string): Promise<void> {
  await page.locator('textarea.composerTextarea').fill('');
  await page.evaluate(base64 => {
    const previous = window.__installedVoiceCapture;
    if (previous?.capture.sourceRate && (!previous.capture.tracksStopped || !previous.capture.contextClosed)) {
      throw new Error('Previous capture was not cleaned up');
    }
    if (previous) previous.active = false;
    const state: BrowserCaptureState = {
      sourceBase64: base64, active: true, uploadBase64: null, status: null, body: null,
      observerError: null, fetchFailure: null, composerText: null,
      timing: { stopAt: null, workletStopAt: null, fetchAt: null, bodyAt: null,
        composerAt: null, terminalAt: null, stopKind: null },
      capture: { sourceRate: null, recorderRate: null, sourceCompleted: false,
        sourceStartedAt: null, sourceEndedAt: null, tracksStopped: false, contextClosed: false },
    };
    window.__installedVoiceCapture = state;
    const observeComposer = () => {
      if (!state.active) return;
      const input = document.querySelector<HTMLTextAreaElement>('textarea.composerTextarea');
      if (state.timing.stopAt !== null && input?.value && state.timing.composerAt === null) {
        state.timing.composerAt = performance.now();
        state.composerText = input.value;
      }
      requestAnimationFrame(observeComposer);
    };
    requestAnimationFrame(observeComposer);
  }, sourceBase64);
}

export async function playBrowserCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__installedVoiceCapture;
    if (!state?.play) throw new Error('Real recorder graph was not ready');
    state.play();
  });
}

export async function snapshotBrowserCapture(page: Page, finish = false): Promise<BrowserCaptureSnapshot> {
  return page.evaluate(done => {
    const state = window.__installedVoiceCapture;
    if (!state) throw new Error('Missing capture state');
    if (done) {
      state.timing.terminalAt = performance.now();
      state.active = false;
    }
    return { uploadBase64: state.uploadBase64, status: state.status, body: state.body,
      observerError: state.observerError, fetchFailure: state.fetchFailure, composerText: state.composerText,
      timing: state.timing, capture: state.capture };
  }, finish);
}
