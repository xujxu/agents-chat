import { expect, test } from '@playwright/test';
import { authenticateViewportDiagnostic } from './helpers/viewportDiagnosticFixture';

test('minimal route serves isolated HTML without framework bootstrap', async ({ page, context }) => {
  await authenticateViewportDiagnostic(context);
  const requests: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  const response = await page.goto('/diagnostics/viewport-minimal');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
  await expect(page.locator('script[src], link[rel="stylesheet"]')).toHaveCount(0);
  expect(requests).toEqual(['/diagnostics/viewport-minimal']);
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /minimum-scale|maximum-scale/);
  expect(await page.locator('#reference').evaluate(element => element.getBoundingClientRect().width)).toBe(100);
});
