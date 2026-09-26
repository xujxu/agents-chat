import { test } from '@playwright/test';
import { registerReadingControllerDiagnostics } from './readingControllerDiagnostics';

export function registerReadingGeometryDiagnostics() {
  registerReadingControllerDiagnostics();
  if (process.env.READING_GEOMETRY_DIAGNOSTICS !== '1') return;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const report: { samples: object[]; dropped: number; errors: string[] } = { samples: [], dropped: 0, errors: [] };
      Object.defineProperty(window, '__readingGeometryDiagnostic', { value: report });
      const sample = (event: Event) => {
        if (report.samples.length >= 512) { report.dropped++; return; }
        try {
          const chat = document.querySelector<HTMLElement>('.chatContainer');
          const composer = document.querySelector<HTMLElement>('.chatInputDock');
          const textarea = document.querySelector<HTMLTextAreaElement>('.composerTextarea');
          const dimensions = (element: HTMLElement | null) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          };
          report.samples.push({
            at: performance.now(), event: event.type,
            viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
            chat: chat ? { ...dimensions(chat), topOffset: chat.scrollTop, clientHeight: chat.clientHeight,
              scrollHeight: chat.scrollHeight, bottomDistance: chat.scrollHeight - chat.clientHeight - chat.scrollTop } : null,
            composer: dimensions(composer), textarea: dimensions(textarea),
          });
        } catch (error) {
          if (report.errors.length < 16) report.errors.push(error instanceof Error ? error.name : 'unknown');
        }
      };
      window.addEventListener('resize', sample);
      document.addEventListener('scroll', sample, true);
      window.addEventListener('DOMContentLoaded', sample);
      visualViewport?.addEventListener('resize', sample);
    });
  });
  test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) throw new Error('Diagnostic page closed before geometry capture');
    const report: unknown = await page.evaluate(() => Reflect.get(window, '__readingGeometryDiagnostic'));
    if (!report || typeof report !== 'object' || !('samples' in report)) throw new Error('Missing geometry diagnostics');
    await info.attach('reading-geometry-history', {
      body: JSON.stringify({ productSha: process.env.DIAGNOSTIC_PRODUCT_SHA,
        harnessSha: process.env.GITHUB_SHA, repeatIndex: info.repeatEachIndex, status: info.status, report }),
      contentType: 'application/json',
    });
    if ('errors' in report && Array.isArray(report.errors) && report.errors.length) {
      throw new Error('Geometry capture incomplete; inspect reading-geometry-history');
    }
  });
}
