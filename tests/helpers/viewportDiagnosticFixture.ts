import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { encode } from 'next-auth/jwt';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { installTypographyFixture } from './typographyFixture';

export const DIAGNOSTIC_BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
export const DIAGNOSTIC_ORIGIN = new URL(DIAGNOSTIC_BASE).origin;
export const DIAGNOSTIC_ENDPOINT = '/api/diagnostics/viewport';

export async function authenticateViewportDiagnostic(context: BrowserContext, role = 'admin') {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Diagnostic API tests require the isolated CI NEXTAUTH_SECRET.');
  const token = await encode({
    secret,
    token: {
      sub: role === 'admin' ? 'admin' : 'viewport-ci',
      email: role === 'admin' ? 'admin@local' : 'viewport-ci@example.test',
      name: 'Viewport CI', role,
    },
  });
  await context.addCookies([{
    name: 'next-auth.session-token', value: token, url: DIAGNOSTIC_BASE, httpOnly: true, sameSite: 'Lax',
  }]);
}

export async function openViewportDiagnostic(page: Page, mode?: string, pathname = '/') {
  const fixture = await installTypographyFixture(page);
  await authenticateViewportDiagnostic(page.context());
  const url = new URL(mode ? `${pathname}?viewportDiagnostics=${mode}` : pathname, DIAGNOSTIC_BASE).href;
  if (['/diagnostics/viewport-history', '/diagnostics/viewport-auto'].includes(pathname) && page.url() === 'about:blank') {
    // Only replace the harness's initial blank document, never a trial document.
    await Promise.all([
      page.waitForURL(url),
      page.evaluate(destination => { location.replace(destination); }, url),
    ]);
  } else {
    await page.goto(url);
  }
  await expect(page.locator('textarea.composerTextarea')).toBeVisible();
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user.role).toBe('admin');
  return fixture;
}

export async function readSavedViewportLog(id: string) {
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const file = path.join(process.cwd(), '.next/standalone/.data/tmp/viewport-diagnostics', `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } finally {
    await unlink(file);
  }
}
