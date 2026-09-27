import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
import { projects } from '../scripts/voice/lifecycle-contract';

export default defineConfig({
  ...base, fullyParallel: false, retries: 0, workers: 1,
  projects: projects(process.platform).map(name => {
    const use = name === 'installed-edge' ? { ...devices['Desktop Edge'], channel: 'msedge' }
      : base.projects?.find(project => project.name === name)?.use;
    if (!use) throw new Error(`Missing existing project ${name}`);
    return { name, use, testMatch: ['**/voice-lifecycle.spec.ts'] };
  }),
});
