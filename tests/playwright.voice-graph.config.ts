import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base, fullyParallel: false, retries: 0, workers: 1,
  projects: base.projects!.filter(project =>
    ['desktop-chromium', 'iphone-webkit'].includes(project.name!)).map(project => ({
    ...project, testIgnore: [],
    testMatch: ['**/voice-audio-graph.spec.ts', '**/voice-input.spec.ts', '**/voice-browser-capture.spec.ts'],
  })),
});
