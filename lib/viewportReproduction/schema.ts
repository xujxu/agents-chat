export const MINIMAL_METRICS = [
  'scale', 'visualWidth', 'visualHeight', 'offsetTop', 'offsetLeft',
  'innerWidth', 'innerHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight',
  'screenWidth', 'screenHeight', 'dpr', 'referenceWidth', 'referenceHeight', 'fontSize',
] as const;
export const MINIMAL_EVENTS = [
  'initial', 'periodic', 'resize', 'orientation', 'touch-start', 'touch-end', 'touch-cancel',
  'stop', 'timeout', 'hidden', 'pagehide',
] as const;
export type MinimalViewportEvent = typeof MINIMAL_EVENTS[number];
export type MinimalViewportSample = {
  t: number;
  events: MinimalViewportEvent[];
  touches: number;
  orientation: 'portrait' | 'landscape';
  visibility: 'visible' | 'hidden';
  metrics: Record<typeof MINIMAL_METRICS[number], number | null>;
};
export type MinimalViewportLog = {
  version: 1;
  experiment: 'native-viewport-minimal';
  browser: 'chrome' | 'safari' | 'other';
  browserVersion: string | null;
  osVersion: string | null;
  clientRevision: string | null;
  initial: MinimalViewportSample;
  samples: MinimalViewportSample[];
  dropped: number;
  stopReason: 'manual' | 'timeout' | 'hidden' | 'pagehide';
};

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some(item => item === value);
}

function version(value: unknown): boolean {
  return value === null || (typeof value === 'string' && /^\d{1,4}(?:\.\d{1,6}){0,3}$/.test(value));
}

function sample(value: unknown): value is MinimalViewportSample {
  if (!exact(value, ['t', 'events', 'touches', 'orientation', 'visibility', 'metrics'])) return false;
  return finite(value.t, 0, 7 * 86400_000)
    && finite(value.touches, 0, 20) && Number.isInteger(value.touches)
    && member(value.orientation, ['portrait', 'landscape'])
    && member(value.visibility, ['visible', 'hidden'])
    && Array.isArray(value.events) && value.events.length > 0 && value.events.length <= MINIMAL_EVENTS.length
    && value.events.every(event => member(event, MINIMAL_EVENTS))
    && new Set(value.events).size === value.events.length
    && exact(value.metrics, MINIMAL_METRICS)
    && Object.values(value.metrics).every(metric => metric === null || finite(metric, -10_000_000, 10_000_000));
}

export function validateMinimalViewportLog(value: unknown): value is MinimalViewportLog {
  if (!exact(value, [
    'version', 'experiment', 'browser', 'browserVersion', 'osVersion', 'clientRevision',
    'initial', 'samples', 'dropped', 'stopReason',
  ])) return false;
  if (value.version !== 1 || value.experiment !== 'native-viewport-minimal'
    || !member(value.browser, ['chrome', 'safari', 'other'])
    || !version(value.browserVersion) || !version(value.osVersion)
    || !(value.clientRevision === null
      || (typeof value.clientRevision === 'string' && /^[a-f0-9]{40}$/.test(value.clientRevision)))
    || !finite(value.dropped, 0, 1_000_000) || !Number.isInteger(value.dropped)
    || !member(value.stopReason, ['manual', 'timeout', 'hidden', 'pagehide'])
    || !sample(value.initial) || value.initial.t !== 0
    || value.initial.events.length !== 1 || value.initial.events[0] !== 'initial'
    || value.initial.visibility !== 'visible' || value.initial.touches !== 0
    || !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 255) return false;
  let previous = 0;
  for (let index = 0; index < value.samples.length; index++) {
    const item: unknown = value.samples[index];
    if (!sample(item) || item.t < previous || item.events.includes('initial')) return false;
    previous = item.t;
    const terminal = item.events.filter(event => ['stop', 'timeout', 'hidden', 'pagehide'].includes(event));
    if (index < value.samples.length - 1 && terminal.length !== 0) return false;
    if (index === value.samples.length - 1) {
      const expected = value.stopReason === 'manual' ? 'stop' : value.stopReason;
      if (terminal.length !== 1 || terminal[0] !== expected) return false;
      if (expected === 'hidden' && item.visibility !== 'hidden') return false;
    }
  }
  return true;
}
