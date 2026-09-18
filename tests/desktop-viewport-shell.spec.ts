import { expect, test } from '@playwright/test';
import {
  installMobileChatFixture,
  loginMobileFixture,
} from './helpers/mobileChatFixture';

test.beforeEach(async ({ page }) => {
  await installMobileChatFixture(page);
  await loginMobileFixture(page);
});

test('keeps a fine-pointer desktop at phone-landscape width on the desktop path', async ({ page }) => {
  await page.setViewportSize({ width: 932, height: 700 });
  const app = page.locator('.chatPageRoot .page');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  await expect(page.locator('.sidebarResizeHandle')).toBeVisible();
  await expect.poll(() => app.evaluate((element) => ({
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
    height: Math.round(element.getBoundingClientRect().height),
  }))).toEqual({ inlineHeight: '700px', height: 700 });
});

test('keeps desktop geometry while clearing viewport overrides in mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });

  const app = page.locator('.chatPageRoot .page');
  const sidebar = page.locator('.participantsSidebar');
  const desktopGeometry = await app.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
    };
  });
  expect(desktopGeometry).toEqual({
    top: 0,
    height: 720,
    inlineHeight: '720px',
  });
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebarResizeHandle')).toBeVisible();

  const expandedSidebarWidth = await sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  );
  expect(expandedSidebarWidth).toBeGreaterThanOrEqual(260);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect.poll(() => sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  )).toBeLessThanOrEqual(60);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(() => sidebar.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  )).toBeGreaterThanOrEqual(260);

  await page.locator('button[title="Agents"]').click();
  const desktopAgents = page.locator('.agentsSidebar');
  await expect(desktopAgents).toBeVisible();
  const resizeHandle = page.locator('.sidebarResizeHandle');
  const chatMain = page.locator('.chatMain');
  await expect.poll(async () => {
    const [appBox, sidebarBox, handleBox, chatBox, agentsBox] = await Promise.all([
      app.boundingBox(),
      sidebar.boundingBox(),
      resizeHandle.boundingBox(),
      chatMain.boundingBox(),
      desktopAgents.boundingBox(),
    ]);
    if (!appBox || !sidebarBox || !handleBox || !chatBox || !agentsBox) return null;
    return {
      sidebarStartsAtApp: Math.round(sidebarBox.x - appBox.x),
      handleFollowsSidebar: Math.round(handleBox.x - (sidebarBox.x + sidebarBox.width)),
      chatFollowsHandle: Math.round(chatBox.x - (handleBox.x + handleBox.width)),
      agentsFollowChat: Math.round(agentsBox.x - (chatBox.x + chatBox.width)),
      agentsWidth: Math.round(agentsBox.width),
      agentsEndAtApp: Math.round(
        appBox.x + appBox.width - (agentsBox.x + agentsBox.width),
      ),
    };
  }).toEqual({
    sidebarStartsAtApp: 0,
    handleFollowsSidebar: 0,
    chatFollowsHandle: 0,
    agentsFollowChat: 0,
    agentsWidth: 260,
    agentsEndAtApp: 0,
  });

  await page.setViewportSize({ width: 880, height: 700 });
  await expect.poll(() => app.evaluate((element) => ({
    position: getComputedStyle(element).position,
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
    inlineTop: (element as HTMLElement).style.getPropertyValue('--app-viewport-offset-top'),
  }))).toEqual({
    position: 'relative',
    inlineHeight: '',
    inlineTop: '',
  });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 680 });
  await expect.poll(() => app.evaluate((element) => ({
    height: Math.round(element.getBoundingClientRect().height),
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
  }))).toEqual({
    height: 680,
    inlineHeight: '680px',
  });
  await expect(sidebar).toBeVisible();
  await expect(page.locator('.sidebarResizeHandle')).toBeVisible();

  await page.setViewportSize({ width: 1200, height: 640 });
  await expect.poll(() => app.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    height: Math.round(element.getBoundingClientRect().height),
    inlineHeight: (element as HTMLElement).style.getPropertyValue('--app-viewport-height'),
  }))).toEqual({
    width: 1200,
    height: 640,
    inlineHeight: '640px',
  });
});
