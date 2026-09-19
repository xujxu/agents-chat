export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
export const MAX_DIAGNOSTIC_SAMPLES = 256;
export const METRIC_KEYS = [
  'scale', 'viewportMinimumScale', 'visualWidth', 'visualHeight', 'offsetTop', 'offsetLeft',
  'innerWidth', 'innerHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight',
  'screenWidth', 'screenHeight', 'dpr', 'shellHeight', 'shellOffsetTop',
  'pageX', 'pageY', 'pageWidth', 'pageHeight',
  'headerX', 'headerY', 'headerWidth', 'headerHeight',
  'transcriptX', 'transcriptY', 'transcriptWidth', 'transcriptHeight',
  'composerX', 'composerY', 'composerWidth', 'composerHeight',
] as const;
export const DIAGNOSTIC_EVENTS = [
  'initial', 'resize', 'scroll', 'orientation', 'touch-start', 'touch-end',
  'touch-cancel', 'focus', 'settled', 'upload', 'probe',
] as const;
export const PROBE_PHASES = [
  'idle', 'arming', 'armed', 'restoring', 'restored', 'not-restored', 'invalidated', 'error',
] as const;
export const PROBE_REASONS = [
  'none', 'fresh-tab', 'geometry', 'touch', 'focus', 'unstable', 'rotation',
  'ownership', 'lifecycle', 'interrupted', 'history-error', 'ack-timeout', 'scale-timeout',
] as const;
export type ProbeEvidence = {
  phase: typeof PROBE_PHASES[number];
  reason: typeof PROBE_REASONS[number];
  owned: boolean;
  documentContinuous: boolean;
  shellContinuous: boolean;
  composerContinuous: boolean;
};
export type DiagnosticMode = 'baseline' | 'isolated';
export type DiagnosticMetrics = Record<typeof METRIC_KEYS[number], number | null>;
export type ViewportSample = {
  t: number;
  event: typeof DIAGNOSTIC_EVENTS[number];
  gesture: boolean;
  focus: 'none' | 'editable' | 'other';
  orientation: 'portrait' | 'landscape';
  mobile: boolean;
  metrics: DiagnosticMetrics;
  probe: ProbeEvidence | null;
};
export type ViewportDiagnosticLog = {
  version: 3;
  experiment: 'native-history' | null;
  mode: DiagnosticMode;
  browser: 'chrome' | 'safari' | 'other';
  browserVersion: string | null;
  osVersion: string | null;
  clientRevision: string | null;
  assets: string[];
  initial: ViewportSample;
  samples: ViewportSample[];
  dropped: number;
};

export function parseDiagnosticMode(value: string | null): DiagnosticMode | null {
  return value === 'baseline' || value === 'isolated' ? value : null;
}

export function shouldPauseViewportSync(
  mode: DiagnosticMode | null, gesture: boolean, scale: number | undefined,
): boolean {
  return mode === 'isolated' && (gesture || (scale !== undefined && Math.abs(scale - 1) > 0.01));
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some(item => item === value);
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function version(value: unknown): boolean {
  return value === null || (typeof value === 'string' && /^\d{1,4}(?:\.\d{1,6}){0,3}$/.test(value));
}

function validSample(value: unknown): value is ViewportSample {
  if (!exactKeys(value, ['t', 'event', 'gesture', 'focus', 'orientation', 'mobile', 'metrics', 'probe'])) return false;
  if (!finite(value.t, 0, 7 * 86400_000) || !member(value.event, DIAGNOSTIC_EVENTS)
    || typeof value.gesture !== 'boolean' || typeof value.mobile !== 'boolean'
    || !member(value.focus, ['none', 'editable', 'other'])
    || !member(value.orientation, ['portrait', 'landscape'])
    || !exactKeys(value.metrics, METRIC_KEYS) || !validProbe(value.probe)) return false;
  const metrics = value.metrics;
  return METRIC_KEYS.every(key => metrics[key] === null || finite(metrics[key], -10_000_000, 10_000_000));
}

function validProbe(value: unknown): value is ProbeEvidence | null {
  if (value === null) return true;
  return exactKeys(value, ['phase', 'reason', 'owned', 'documentContinuous', 'shellContinuous', 'composerContinuous'])
    && member(value.phase, PROBE_PHASES) && member(value.reason, PROBE_REASONS)
    && typeof value.owned === 'boolean' && typeof value.documentContinuous === 'boolean'
    && typeof value.shellContinuous === 'boolean' && typeof value.composerContinuous === 'boolean';
}

export function isDiagnosticAsset(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 180
    && /^\/_next\/static\/[a-zA-Z0-9_./~-]+\.css$/.test(value) && !value.includes('..');
}

export function validateDiagnosticLog(value: unknown): value is ViewportDiagnosticLog {
  if (!exactKeys(value, [
    'version', 'experiment', 'mode', 'browser', 'browserVersion', 'osVersion', 'clientRevision', 'assets', 'initial', 'samples', 'dropped',
  ])) return false;
  if (value.version !== 3 || !(value.experiment === null || value.experiment === 'native-history')
    || (value.experiment !== null && value.mode !== 'baseline') || !member(value.mode, ['baseline', 'isolated'])
    || !member(value.browser, ['chrome', 'safari', 'other'])
    || !version(value.browserVersion) || !version(value.osVersion)
    || !(value.clientRevision === null || (typeof value.clientRevision === 'string' && /^[a-f0-9]{40}$/.test(value.clientRevision)))
    || !Array.isArray(value.assets) || value.assets.length > 32 || !value.assets.every(isDiagnosticAsset)
    || !validSample(value.initial) || value.initial.t !== 0 || value.initial.event !== 'initial'
    || !Array.isArray(value.samples) || value.samples.length > MAX_DIAGNOSTIC_SAMPLES
    || !finite(value.dropped, 0, 1_000_000) || !Number.isInteger(value.dropped)) return false;
  const matchesExperiment = (sample: ViewportSample) =>
    (sample.probe !== null) === (value.experiment === 'native-history')
    && (sample.event !== 'probe' || value.experiment === 'native-history');
  if (!matchesExperiment(value.initial)) return false;
  let previous = 0;
  return value.samples.every(sample => {
    if (!validSample(sample) || !matchesExperiment(sample) || sample.event === 'initial' || sample.t < previous) return false;
    previous = sample.t;
    return true;
  });
}

export function createViewportRecorder(initial: ViewportDiagnosticLog) {
  const log = structuredClone(initial);
  return {
    record(sample: ViewportSample) {
      log.samples.push(sample);
      if (log.samples.length > MAX_DIAGNOSTIC_SAMPLES) {
        log.samples.shift();
        log.dropped++;
      }
    },
    snapshot(): ViewportDiagnosticLog {
      const snapshot = structuredClone(log);
      const encoder = new TextEncoder();
      while (snapshot.samples.length && encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_DIAGNOSTIC_BYTES) {
        snapshot.samples.shift();
        snapshot.dropped++;
      }
      return snapshot;
    },
  };
}
