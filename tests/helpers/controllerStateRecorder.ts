type Geometry = { width: number; height: number; contentHeight: number };

export type ControllerDiagnosticState = {
  following: boolean;
  userIntent: boolean;
  jumping: boolean;
  suspended: boolean;
  disposed: boolean;
  multiTouch: boolean;
  scrollbarDrag: boolean;
  correctionPending: boolean;
  anchorPresent: boolean;
  expectedTop: number | null;
  lastTop: number;
  cached: Geometry;
  current: Geometry;
  scrollTop: number;
  requestedTop?: number;
};

export type ControllerDiagnosticReport = {
  events: {
    sequence: number;
    at: number;
    controller: number;
    kind: string;
    state: ControllerDiagnosticState;
  }[];
  dropped: number;
  errors: string[];
  errorsDropped: number;
};

export type ControllerDiagnosticChannel = {
  nextId: number;
  report: ControllerDiagnosticReport;
  record: (controller: number, kind: string, read: () => ControllerDiagnosticState) => void;
};

declare global {
  interface Window {
    __chatScrollDiagnostic?: ControllerDiagnosticChannel;
  }
}

// Keep this initializer self-contained: Playwright serializes it into each page.
export function initializeControllerDiagnostics() {
  const report: ControllerDiagnosticReport = { events: [], dropped: 0, errors: [], errorsDropped: 0 };
  const channel: ControllerDiagnosticChannel = {
    nextId: 1,
    report,
    record(controller, kind, read) {
      if (report.events.length >= 2048) { report.dropped++; return; }
      try {
        const state = read();
        report.events.push({
          sequence: report.events.length, at: performance.now(), controller, kind,
          state: { ...state, cached: { ...state.cached }, current: { ...state.current } },
        });
      } catch (error) {
        if (report.errors.length < 16) report.errors.push(error instanceof Error ? error.name : 'unknown');
        else report.errorsDropped++;
      }
    },
  };
  Object.defineProperty(window, '__chatScrollDiagnostic', { value: channel });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}

export function requireCompleteReport(report: unknown): asserts report is ControllerDiagnosticReport {
  if (!object(report) || !Array.isArray(report.events) || report.events.length > 2048
    || !count(report.dropped) || !Array.isArray(report.errors) || report.errors.length > 16
    || report.errors.some(error => typeof error !== 'string') || !count(report.errorsDropped)) {
    throw new Error('Malformed controller diagnostic report');
  }
  for (const [index, event] of report.events.entries()) {
    if (!object(event) || event.sequence !== index || !finite(event.at)
      || !count(event.controller) || event.controller < 1 || typeof event.kind !== 'string' || !event.kind
      || !object(event.state)) throw new Error('Malformed controller diagnostic event');
    const state = event.state;
    for (const key of ['following', 'userIntent', 'jumping', 'suspended', 'disposed', 'multiTouch',
      'scrollbarDrag', 'correctionPending', 'anchorPresent']) {
      if (typeof state[key] !== 'boolean') throw new Error(`Malformed controller state: ${key}`);
    }
    for (const key of ['lastTop', 'scrollTop']) {
      if (!finite(state[key])) throw new Error(`Malformed controller state: ${key}`);
    }
    if ((state.expectedTop !== null && !finite(state.expectedTop))
      || (state.requestedTop !== undefined && !finite(state.requestedTop))) {
      throw new Error('Malformed controller scroll target');
    }
    for (const key of ['cached', 'current']) {
      const geometry = state[key];
      if (!object(geometry) || !finite(geometry.width) || !finite(geometry.height) || !finite(geometry.contentHeight)) {
        throw new Error(`Malformed controller geometry: ${key}`);
      }
    }
  }
  if (report.dropped || report.errors.length || report.errorsDropped) {
    throw new Error('Controller capture incomplete; inspect reading-controller-history');
  }
  if (!report.events.length) throw new Error('Controller diagnostic history empty');
}
