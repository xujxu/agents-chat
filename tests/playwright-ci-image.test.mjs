import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Playwright CI image matches the locked @playwright/test version', () => {
  const workflow = readFileSync(new URL('../.github/workflows/playwright.yml', import.meta.url), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const image = workflow.match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1];
  assert.equal(image, lock.packages['node_modules/@playwright/test'].version);
  assert.equal(lock.packages[''].devDependencies['@playwright/test'], image, 'pin an exact version so the image cannot drift');
});
