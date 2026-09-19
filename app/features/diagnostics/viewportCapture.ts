import {
  METRIC_KEYS, isDiagnosticAsset,
  type DiagnosticMetrics, type DiagnosticMode, type ViewportDiagnosticLog, type ViewportSample,
} from '../../../lib/viewportDiagnostics';

export function captureViewportSample(
  event: ViewportSample['event'], t: number, gesture: boolean,
): ViewportSample {
  const metrics = Object.fromEntries(METRIC_KEYS.map(key => [key, null])) as DiagnosticMetrics;
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const page = document.querySelector<HTMLElement>('.chatPageRoot .page');
  Object.assign(metrics, {
    scale: viewport?.scale ?? null,
    visualWidth: viewport?.width ?? null, visualHeight: viewport?.height ?? null,
    offsetTop: viewport?.offsetTop ?? null, offsetLeft: viewport?.offsetLeft ?? null,
    innerWidth, innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight,
    scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
    screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio,
  });
  for (const [prefix, selector] of [
    ['page', '.chatPageRoot .page'], ['header', '.chatPageRoot .header'],
    ['transcript', '.chatPageRoot .chatContainer'], ['composer', '.chatPageRoot .composerTextarea'],
  ] as const) {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    if (!box) continue;
    metrics[`${prefix}X`] = box.x;
    metrics[`${prefix}Y`] = box.y;
    metrics[`${prefix}Width`] = box.width;
    metrics[`${prefix}Height`] = box.height;
  }
  if (page) {
    const style = getComputedStyle(page);
    for (const [key, property] of [
      ['shellHeight', '--app-viewport-height'], ['shellOffsetTop', '--app-viewport-offset-top'],
    ] as const) {
      const value = Number.parseFloat(style.getPropertyValue(property));
      metrics[key] = Number.isFinite(value) ? value : null;
    }
  }
  const active = document.activeElement;
  const focus = !active || active === document.body || active === root ? 'none'
    : active.matches('input, textarea, [contenteditable="true"]') ? 'editable' : 'other';
  return {
    t, event, gesture, focus, metrics,
    orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
    mobile: matchMedia('(max-width: 900px)').matches,
  };
}

export function initialViewportLog(mode: DiagnosticMode): ViewportDiagnosticLog {
  const agent = navigator.userAgent;
  const chrome = agent.match(/(?:CriOS|Chrome)\/([\d.]+)/);
  const safari = agent.includes('Safari') ? agent.match(/Version\/([\d.]+)/) : null;
  const os = agent.match(/(?:CPU (?:iPhone )?OS|iPhone OS) (\d+(?:_\d+){1,3})/);
  const assets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map(link => new URL(link.href, location.href))
    .filter(url => url.origin === location.origin)
    .map(url => url.pathname)
    .filter(isDiagnosticAsset);
  return {
    version: 1, mode, browser: chrome ? 'chrome' : safari ? 'safari' : 'other',
    browserVersion: chrome?.[1] ?? safari?.[1] ?? null,
    osVersion: os?.[1].replaceAll('_', '.') ?? null,
    clientRevision: process.env.NEXT_PUBLIC_VIEWPORT_DIAGNOSTICS_REVISION ?? null,
    assets: [...new Set(assets)].slice(0, 32),
    initial: captureViewportSample('initial', 0, false), samples: [], dropped: 0,
  };
}
