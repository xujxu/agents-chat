import { test } from '@playwright/test';
import { initializeControllerDiagnostics, requireCompleteReport } from './controllerStateRecorder';

export function registerReadingControllerDiagnostics() {
  if (process.env.READING_CONTROLLER_DIAGNOSTICS !== '1') return;
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(initializeControllerDiagnostics);
  });
  test.afterEach(async ({ page }, info) => {
    if (page.isClosed()) throw new Error('Diagnostic page closed before controller capture');
    const report: unknown = await page.evaluate(() => window.__chatScrollDiagnostic?.report ?? null);
    await info.attach('reading-controller-history', {
      body: JSON.stringify({
        productSha: process.env.DIAGNOSTIC_PRODUCT_SHA, harnessSha: process.env.GITHUB_SHA,
        repeatIndex: info.repeatEachIndex, status: info.status, report,
      }),
      contentType: 'application/json',
    });
    requireCompleteReport(report);
  });
}
