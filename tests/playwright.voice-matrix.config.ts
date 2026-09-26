import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
import { browserCases } from '../scripts/voice/browser-cases';

const mobile = base.projects?.find(project => project.name === 'iphone-webkit');
if (!mobile?.use) throw new Error('Existing iPhone WebKit settings are required');

export default defineConfig({
  ...base,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  projects: Object.values(browserCases).map(selected => ({
    name: selected.project,
    testMatch: ['**/voice-input.spec.ts', '**/voice-browser-capture.spec.ts', '**/voice-installed-browser.spec.ts'],
    use: selected.browserName === 'webkit' ? mobile.use
      : { ...devices[selected.device], channel: selected.channel ?? undefined },
  })),
});
