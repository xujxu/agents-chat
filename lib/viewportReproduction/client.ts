import type { createMinimalRecorder, MinimalSnapshot } from './recorder.ts';
import type { MinimalViewportEvent, MinimalViewportLog, MinimalViewportSample } from './schema.ts';

// This function is serialized, not hydrated. All runtime dependencies must be explicit.
export function minimalViewportClient(makeRecorder: typeof createMinimalRecorder): void {
  const start = document.querySelector<HTMLButtonElement>('#start');
  const stop = document.querySelector<HTMLButtonElement>('#stop');
  const upload = document.querySelector<HTMLButtonElement>('#upload');
  const status = document.querySelector<HTMLElement>('#status');
  const reference = document.querySelector<HTMLElement>('#reference');
  const specimen = document.querySelector<HTMLElement>('#specimen');
  if (!start || !stop || !upload || !status || !reference || !specimen) {
    throw new Error('Minimal viewport controls are missing.');
  }
  const controls = { start, stop, upload, status, reference, specimen };
  let touches = 0;
  let recorder: ReturnType<typeof makeRecorder> | null = null;
  let frozen: MinimalSnapshot | null = null;
  let started = 0;
  let interval: number | undefined;
  let deadline: number | undefined;
  let frame: number | undefined;
  const pending = new Set<MinimalViewportEvent>();

  function show(message: string, error = false): void {
    controls.status.textContent = message;
    controls.status.dataset.error = String(error);
  }

  function capture(events: MinimalViewportEvent[], t: number): MinimalViewportSample {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const box = controls.reference.getBoundingClientRect();
    const font = Number.parseFloat(getComputedStyle(controls.specimen).fontSize);
    return {
      t, events, touches,
      orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
      visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
      metrics: {
        scale: viewport?.scale ?? null, visualWidth: viewport?.width ?? null,
        visualHeight: viewport?.height ?? null, offsetTop: viewport?.offsetTop ?? null,
        offsetLeft: viewport?.offsetLeft ?? null, innerWidth, innerHeight,
        clientWidth: root.clientWidth, clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
        screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio,
        referenceWidth: box.width, referenceHeight: box.height,
        fontSize: Number.isFinite(font) ? font : null,
      },
    };
  }

  function record(events: MinimalViewportEvent[]): void {
    recorder?.record(capture(events, performance.now() - started));
  }

  function flush(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (pending.size) record([...pending]);
    pending.clear();
  }

  function queue(event: MinimalViewportEvent): void {
    if (!recorder) return;
    pending.add(event);
    if (frame === undefined) frame = requestAnimationFrame(flush);
  }

  function finish(reason: MinimalViewportLog['stopReason']): void {
    if (!recorder) return;
    clearInterval(interval);
    clearTimeout(deadline);
    flush();
    record([reason === 'manual' ? 'stop' : reason]);
    try {
      frozen = recorder.finish(reason);
    } catch (error) {
      console.error('Minimal viewport recording could not be frozen.', error);
      show('Recording failed. No log was uploaded. Start a new recording.', true);
      recorder = null;
      controls.start.disabled = false;
      controls.stop.disabled = true;
      return;
    }
    recorder = null;
    controls.start.disabled = false;
    controls.stop.disabled = true;
    controls.upload.disabled = false;
    const last = frozen.log.samples[frozen.log.samples.length - 1].metrics;
    const interrupted = reason === 'hidden' || reason === 'pagehide';
    show(`${interrupted ? 'Interrupted' : 'Frozen'} (${reason}). Scale: ${last.scale}; widths: ${last.visualWidth}/${last.clientWidth}. Samples: ${frozen.log.samples.length + 1}; dropped: ${frozen.log.dropped}.`);
  }

  controls.start.addEventListener('click', () => {
    if (!window.visualViewport) {
      show('VisualViewport is unavailable. This browser cannot record the required native measurements.', true);
      return;
    }
    if (document.visibilityState !== 'visible') {
      show('Return to a visible page before recording.', true);
      return;
    }
    if (touches) {
      show('Release all contacts before recording.', true);
      return;
    }
    if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) {
      show('Leave the editable field before recording.', true);
      return;
    }
    const initial = capture(['initial'], 0);
    const m = initial.metrics;
    if (m.scrollWidth === null || (m.clientWidth !== null && m.scrollWidth - m.clientWidth > 2)) {
      show('Document overflow prevents a valid baseline.', true);
      return;
    }
    if (m.scale === null || !Number.isFinite(m.scale) || Math.abs(m.scale - 1) > 0.01
      || m.visualWidth === null || !Number.isFinite(m.visualWidth) || m.visualWidth <= 0
      || m.clientWidth === null || m.clientWidth <= 0 || Math.abs(m.visualWidth - m.clientWidth) > 2) {
      show('Start at original scale with matching visual and document widths. No scale change was attempted.', true);
      return;
    }
    const agent = navigator.userAgent;
    const chrome = agent.match(/(?:CriOS|Chrome)\/([\d.]+)/);
    const safari = agent.includes('Safari') ? agent.match(/Version\/([\d.]+)/) : null;
    const os = agent.match(/(?:CPU (?:iPhone )?OS|iPhone OS) (\d+(?:_\d+){1,3})/);
    frozen = null;
    controls.start.disabled = true;
    controls.stop.disabled = false;
    controls.upload.disabled = true;
    controls.upload.textContent = 'Upload diagnostic log';
    show('Recording for up to 30 seconds. Readings stay hidden until Stop. No scale recovery runs.');
    started = performance.now();
    recorder = makeRecorder({
      version: 1, experiment: 'native-viewport-minimal',
      browser: chrome ? 'chrome' : safari ? 'safari' : 'other',
      browserVersion: chrome?.[1] ?? safari?.[1] ?? null,
      osVersion: os?.[1].replaceAll('_', '.') ?? null,
      clientRevision: document.body.dataset.revision || null, initial,
    });
    interval = window.setInterval(() => { pending.add('periodic'); flush(); }, 200);
    deadline = window.setTimeout(() => finish('timeout'), 30_000);
  });
  controls.stop.addEventListener('click', () => finish('manual'));
  for (const [event, label] of [
    ['touchstart', 'touch-start'], ['touchend', 'touch-end'], ['touchcancel', 'touch-cancel'],
  ] as const) {
    window.addEventListener(event, (event: TouchEvent) => {
      touches = event.touches.length;
      queue(label);
    }, { passive: true });
  }
  window.addEventListener('resize', () => queue('resize'), { passive: true });
  window.visualViewport?.addEventListener('resize', () => queue('resize'), { passive: true });
  window.addEventListener('orientationchange', () => queue('orientation'), { passive: true });
  window.addEventListener('pagehide', () => finish('pagehide'), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') finish('hidden');
  });
  controls.upload.addEventListener('click', async () => {
    if (!frozen || recorder) return;
    const body = frozen.body;
    controls.start.disabled = true;
    controls.upload.disabled = true;
    show('Uploading frozen diagnostic log.');
    try {
      const response = await fetch('/api/diagnostics/viewport/minimal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === 'object' && result !== null && 'message' in result
          && typeof result.message === 'string' ? result.message : `Upload failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true
        || !('id' in result) || typeof result.id !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.id)) {
        throw new Error('Invalid upload response.');
      }
      show(`Saved log: ${result.id}`);
      controls.upload.textContent = 'Upload diagnostic log';
    } catch (error) {
      console.error('Minimal viewport upload failed.', error);
      show(`Upload failed. ${error instanceof Error ? error.message : 'Retry the frozen recording.'}`, true);
      controls.upload.textContent = 'Retry upload';
    } finally {
      controls.start.disabled = false;
      controls.upload.disabled = false;
    }
  });
}
