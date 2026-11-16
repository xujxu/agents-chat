import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010';
const CUT_RESULT = 'r'.repeat(2_000);
const LONG_ARGS = JSON.stringify({ query: 'a'.repeat(2_500) });

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('input[placeholder="Admin username"]').fill('admin');
  await page.locator('input[placeholder="Password"]').fill('admin123');
  await page.getByRole('button', { name: 'Sign in as Admin', exact: true }).click();
  await page.waitForSelector('.chatContainer, .emptyHomepage', { timeout: 30_000 });
}

function toolParts() {
  return [
    { kind: 'tool', toolName: 'short_tool', args: '{"q":1}', result: 'short output', resultTruncated: false, done: true },
    { kind: 'tool', toolName: 'cut_tool', args: '{}', result: CUT_RESULT, resultTruncated: true, done: true },
    { kind: 'tool', toolName: 'long_args_tool', args: LONG_ARGS, result: 'ok', done: true },
    { kind: 'tool', toolName: 'legacy_cut_tool', result: CUT_RESULT, done: true },
  ];
}

test('tool calls explain truncated output', async ({ page }) => {
  const chatId = `tool-labels-${Date.now()}`;
  const chatName = `Tool labels ${chatId}`;
  await page.route('**/api/acp', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; sessionId?: string };
    if (body.action === 'list-agents') {
      await route.fulfill({ json: { ok: true, agents: [{ id: 'alpha', name: 'Alpha Agent', command: 'mock', args: [], cwd: '', running: true }] } });
      return;
    }
    if (body.action === 'resume-session') {
      await route.fulfill({ json: { ok: true, loaded: true, sessionId: body.sessionId, activeTurn: null, recoveredMessages: [] } });
      return;
    }
    await route.fulfill({ json: { ok: true, activeTurn: null } });
  });

  await login(page);
  await page.evaluate(async ({ id, name, parts }) => {
    const now = Date.now();
    await fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat: { id, name, ts: now, agentSessions: {}, messages: [
        { id: 'user-1', type: 'user', content: 'Run the tools', ts: now - 1 },
        { id: 'agent-1', type: 'agent', agentId: 'alpha', content: 'Done with tools', ts: now, parts: [...parts, { kind: 'text', text: 'Done with tools' }] },
      ] } }),
    });
  }, { id: chatId, name: chatName, parts: toolParts() });

  await page.reload();
  await page.waitForSelector('.chatContainer', { timeout: 30_000 });
  await page.getByTitle(chatName, { exact: true }).click();
  const message = page.locator('.message.agent', { hasText: 'Done with tools' });
  await expect(message.locator('.toolCallItem')).toHaveCount(4, { timeout: 30_000 });
  // Collapsed tools keep their text in the page so browser find-in-page still reaches it.
  await expect(message.locator('.toolCallDetail')).toHaveCount(7);
  await expect(message.locator('.toolCallTruncated')).toHaveCount(3);

  const item = (name: string) => message.locator('.toolCallItem').filter({ has: page.locator('.toolCallName', { hasText: new RegExp(`^${name}$`) }) });

  await item('short_tool').locator('summary').click();
  await expect(item('short_tool')).toHaveAttribute('open', '');
  await expect(item('short_tool').locator('.toolCallResult')).toHaveText('short output');
  await expect(item('short_tool').locator('.toolCallTruncated')).toHaveCount(0);

  await item('cut_tool').locator('summary').click();
  await expect(item('cut_tool').locator('.toolCallTruncated'))
    .toHaveText('Output truncated: only the first 2,000 characters were saved.');

  await item('long_args_tool').locator('summary').click();
  await expect(item('long_args_tool').locator('.toolCallTruncated'))
    .toHaveText('Input shortened: showing the first 2,000 characters.');

  await item('legacy_cut_tool').locator('summary').click();
  await expect(item('legacy_cut_tool').locator('.toolCallTruncated'))
    .toHaveText('Output truncated: only the first 2,000 characters were saved.');

  await page.goto('about:blank');
  expect((await page.context().request.delete(`${BASE}/api/chats?id=${encodeURIComponent(chatId)}`)).ok()).toBeTruthy();
});

test('shared chats label truncated tool output', async ({ page }) => {
  await page.route('**/api/share**', (route) => route.fulfill({
    json: { ok: true, chat: {
      shareId: 'tool-labels', name: 'Shared tools', sharedBy: 'admin@local', sharedAt: 1000,
      messages: [{ id: 'agent-1', type: 'agent', agentId: 'alpha', content: 'Done', ts: 1000, parts: toolParts() }],
    } },
  }));
  await login(page);
  await page.goto(`${BASE}/share/tool-labels`);
  const tools = page.locator('.shareTool');
  await expect(tools).toHaveCount(4);
  await expect(page.locator('.shareToolTruncated')).toHaveCount(2);
  await expect(tools.nth(0).locator('.shareToolTruncated')).toHaveCount(0);
  await expect(tools.nth(1).locator('.shareToolTruncated')).toHaveText('Output truncated: only the first 2,000 characters were saved.');
  await expect(tools.nth(3).locator('.shareToolTruncated')).toHaveCount(1);
});
