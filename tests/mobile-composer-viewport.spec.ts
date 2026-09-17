import { expect, Page, test } from '@playwright/test';
import {
  installTestVisualViewport,
  setTestVisualViewport,
} from './helpers/visualViewport';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  const username = page.locator('input[placeholder="Admin username"]');
  const password = page.locator('input[placeholder="Password"]');
  const submit = page.locator('button[type="submit"]');
  await expect(async () => {
    await username.fill(process.env.ADMIN_USERNAME || 'admin');
    await password.fill(process.env.ADMIN_PASSWORD || 'admin123');
    await expect(submit).toBeEnabled();
  }).toPass({ timeout: 30000 });
  await submit.click();
  await expect(page.locator('.chatContainer, .emptyHomepage')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(500);
}

test('keeps composer controls and overlays inside a reduced layout viewport', async ({ page }) => {
  await installTestVisualViewport(page);

  const chats = new Map<string, Record<string, unknown>>();
  const agents = ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} Agent`,
    command: 'mock',
    args: [],
    cwd: '/tmp',
    running: true,
    canTalk: true,
    canModify: true,
    public: true,
    models: [
      { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { modelId: 'gpt-5.4', name: 'GPT-5.4' },
    ],
    defaultModelId: 'claude-sonnet-4.6',
  }));
  let lastChatId = '';
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        const chat = chats.get(id);
        await route.fulfill({
          status: chat ? 200 : 404,
          contentType: 'application/json',
          body: JSON.stringify(chat ? { ok: true, chat } : { ok: false, error: 'not_found' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          chats: [...chats.values()].map((chat) => ({
            id: chat.id,
            name: chat.name,
            ts: chat.ts,
          })),
          lastChatId,
        }),
      });
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body?.chat) chats.set(body.chat.id, body.chat);
      if (body?.action === 'set-last-chat') lastChatId = body.chatId || '';
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/orchestrations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }),
  );
  let generationActive = false;
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === 'list-agents') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agents,
        }),
      });
      return;
    }
    if (body?.action === 'get-agent-config') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          agent: agents.find((agent) => agent.id === body.agentId),
        }),
      });
      return;
    }
    if (body?.action === 'list-agent-access') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, access: [] }),
      });
      return;
    }
    if (body?.action === 'send') {
      generationActive = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          sessionId: 'mobile-viewport-session',
          turn: { id: 'mobile-viewport-turn' },
        }),
      });
      return;
    }
    if (body?.action === 'poll' && generationActive) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          activeTurn: {
            id: 'mobile-viewport-turn',
            fullText: '',
            done: false,
            phase: 'thinking',
            statusText: 'Thinking',
            events: [],
          },
        }),
      });
      return;
    }
    if (body?.action === 'interrupt') {
      generationActive = false;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await login(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /width=device-width.*initial-scale=1.*interactive-widget=resizes-content/,
  );
  await page.locator('button.emptyHomepageNewChat').click();
  const textarea = page.locator('textarea.composerTextarea');
  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.fill('@alpha @beta @gamma @delta mobile viewport');

  const originalViewport = page.viewportSize();
  expect(originalViewport).not.toBeNull();
  await page.setViewportSize({ width: 430, height: 430 });
  await setTestVisualViewport(page, 430, 0);

  const app = page.locator('.chatPageRoot .page');
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  }), { timeout: 30_000 }).toEqual({ top: 0, height: 430 });

  const sendButton = page.getByRole('button', { name: 'Send message' });
  const modelButton = page.getByRole('button', { name: 'Model for alpha' });
  const targetPills = page.locator('.targetPills');
  await expect(sendButton).toBeVisible();
  await expect(modelButton).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start voice input' })).toHaveCount(0);
  await expect(targetPills).toHaveCSS('overflow-x', 'auto');
  await expect.poll(
    () => targetPills.evaluate((element) => element.scrollWidth > element.clientWidth),
    { timeout: 30_000 },
  ).toBe(true);

  for (const locator of [page.locator('.chatInputDock'), sendButton, modelButton]) {
    const [controlRect, appRect] = await Promise.all([
      locator.evaluate((element) => element.getBoundingClientRect().toJSON()),
      app.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(controlRect.bottom).toBeLessThanOrEqual(appRect.bottom + 1);
  }
  await expect.poll(() => targetPills.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  }), { timeout: 30_000 }).toBeGreaterThan(0);
  await targetPills.evaluate((element) => {
    element.scrollLeft = 0;
  });

  await textarea.fill('@alpha mobile viewport');
  await sendButton.click();
  const stopButton = page.getByRole('button', { name: 'Stop generation' });
  await expect(stopButton).toBeVisible();
  const [stopBox, compressedAppBox] = await Promise.all([stopButton.boundingBox(), app.boundingBox()]);
  expect(stopBox).not.toBeNull();
  expect(compressedAppBox).not.toBeNull();
  expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(compressedAppBox!.x + compressedAppBox!.width + 1);
  expect(stopBox!.y + stopBox!.height).toBeLessThanOrEqual(compressedAppBox!.y + compressedAppBox!.height + 1);

  await modelButton.click();
  const modelMenu = page.getByRole('listbox', { name: 'Model for alpha' });
  await expect(modelMenu).toBeVisible();
  await expect.poll(async () => {
    const [menuRect, appRect] = await Promise.all([
      modelMenu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
      app.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }),
    ]);
    return menuRect.top >= appRect.top && menuRect.bottom <= appRect.bottom;
  }).toBe(true);

  await modelButton.click();
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty('--safe-area-top', '17px');
    root.setProperty('--safe-area-right', '11px');
    root.setProperty('--safe-area-bottom', '13px');
    root.setProperty('--safe-area-left', '7px');
  });
  await expect.poll(() => page.locator('.header').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingLeft: style.paddingLeft,
      minHeight: style.minHeight,
    };
  })).toEqual({
    paddingTop: '23px',
    paddingRight: '21px',
    paddingLeft: '17px',
    minHeight: '69px',
  });

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const mobileSidebar = page.locator('.participantsSidebar');
  const backdrop = page.locator('.mobilePanelBackdrop');
  await expect(mobileSidebar).toBeVisible();
  await expect(backdrop).toBeVisible();
  await expect.poll(async () => ({
    sidebar: await mobileSidebar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    }),
    backdrop: await backdrop.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    }),
  })).toEqual({
    sidebar: { top: 0, height: 430 },
    backdrop: { top: 0, height: 430 },
  });
  await expect.poll(() => mobileSidebar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      paddingTop: style.paddingTop,
      paddingLeft: style.paddingLeft,
    };
  })).toEqual({
    paddingTop: '69px',
    paddingLeft: '19px',
  });
  await backdrop.click({ force: true });

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  const agentsPanel = page.locator('.agentsSidebar.mobilePanelVisible');
  await expect(agentsPanel).toBeVisible();
  await expect.poll(() => agentsPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    };
  })).toEqual({ top: 0, bottom: 430 });

  await agentsPanel.getByText('Alpha Agent', { exact: true }).click();
  const agentsSheet = page.getByRole('dialog', { name: /Alpha Agent settings/ });
  await expect(agentsSheet).toBeVisible();
  await expect.poll(() => agentsSheet.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
    };
  })).toEqual({
    top: 0,
    bottom: 430,
    paddingTop: '31px',
    paddingRight: '25px',
    paddingBottom: '27px',
    paddingLeft: '21px',
  });

  await page.setViewportSize(originalViewport!);
  await setTestVisualViewport(page, originalViewport!.height, 0);
  await expect.poll(() => app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  }), { timeout: 30_000 }).toEqual({ top: 0, height: originalViewport!.height });
});
