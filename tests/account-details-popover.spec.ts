/**
 * Playwright E2E test for the account-details popover.
 *
 * Clicking the username in the header user chip opens a popover that shows the
 * signed-in account's name, email and role, plus a Sign out action. The popover
 * closes on Escape and on outside click.
 *
 * Requires: dev server running on localhost:3010 with admin credentials
 * (ADMIN_USERNAME / ADMIN_PASSWORD), matching the rest of the UI suite.
 * Run:  npx playwright test tests/account-details-popover.spec.ts
 */

import { test, expect, Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

/** Login helper — fills admin credentials and waits for the chat UI. */
async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const usernameInput = page.locator('input[placeholder="Admin username"]');
  const passwordInput = page.locator('input[placeholder="Password"]');
  await usernameInput.fill(ADMIN_USER);
  await passwordInput.fill(ADMIN_PASS);
  await expect(page.locator('button[type="submit"]')).toBeEnabled({ timeout: 10000 });
  await page.click('button[type="submit"]');
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30000 });
  await page.waitForTimeout(500);
}

test.describe('Account details popover', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('opens account details when the username is clicked', async ({ page }) => {
    const popover = page.locator('.accountMenu');
    await expect(popover).toHaveCount(0);

    await page.locator('.userChip .userNameButton').click();

    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute('role', 'dialog');

    // Name / Email / Role rows are present with the admin account's values.
    await expect(popover.locator('.accountMenuName')).toHaveText('Admin');
    const rows = popover.locator('.accountMenuRow');
    await expect(rows.filter({ hasText: 'Name' })).toContainText('Admin');
    await expect(rows.filter({ hasText: 'Email' })).toContainText('admin@local');
    await expect(rows.filter({ hasText: 'Role' })).toContainText('Administrator');

    // Sign out action is available inside the popover.
    await expect(popover.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('closes the popover when Escape is pressed', async ({ page }) => {
    const popover = page.locator('.accountMenu');
    await page.locator('.userChip .userNameButton').click();
    await expect(popover).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  });

  test('closes the popover when clicking outside of it', async ({ page }) => {
    const popover = page.locator('.accountMenu');
    await page.locator('.userChip .userNameButton').click();
    await expect(popover).toBeVisible();

    // Click on the header title, which is outside the user chip.
    await page.locator('.header h1').click();
    await expect(popover).toHaveCount(0);
  });

  test('Users & roles labels inherited roles and keeps text sizes consistent', async ({ page }) => {
    const users = [
      { email: 'admin@local', role: 'admin', sources: ['env'], uiRole: null, agents: [] },
      { email: 'guest@outside.com', role: 'guest', sources: ['grant'], uiRole: null, agents: [{ id: 'a', name: 'Agent A' }] },
      { email: 'env@contoso.com', role: 'member', sources: ['env'], uiRole: null, envMember: '*@contoso.com', agents: [] },
      { email: 'ui@contoso.com', role: 'member', sources: ['ui'], uiRole: 'member', agents: [] },
    ];
    await page.route('**/api/users**', (route) => route.fulfill({ json: { ok: true, me: 'admin@local', users, envPatterns: { admins: [], members: ['*@contoso.com'] } } }));

    await page.locator('.userChip .userNameButton').click();
    await page.locator('.accountMenu').getByRole('button', { name: 'Users & roles' }).click();
    const dialog = page.locator('.modal', { hasText: 'Users & roles' });
    await expect(dialog.locator('.usersRolesItem')).toHaveCount(4);

    const emptyOption = (email: string) => dialog.getByLabel(`UI role for ${email}`).locator('option[value=""]');
    await expect(emptyOption('guest@outside.com')).toHaveText('Guest (agent access)');
    await expect(emptyOption('env@contoso.com')).toHaveText('Member (env)');
    await expect(emptyOption('ui@contoso.com')).toHaveText('Remove UI role');
    await expect(dialog.getByText('— no UI role —')).toHaveCount(0);

    const sizes = await dialog.evaluate((modal) => {
      const size = (selector: string) => getComputedStyle(modal.querySelector(selector) as Element).fontSize;
      return { email: size('.usersRolesEmail'), input: size('.usersRolesAdd input'), select: size('.usersRolesActions select') };
    });
    expect(sizes.email).toBe(sizes.input);
    expect(sizes.select).toBe(sizes.input);
  });
});
