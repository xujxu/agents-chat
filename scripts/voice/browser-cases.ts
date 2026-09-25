import { readFileSync } from 'node:fs';

export type BrowserCase = {
  platform: 'win32' | 'linux';
  project: string;
  browserName: 'chromium' | 'webkit';
  channel: 'msedge' | null;
  device: string;
};

function loadCases(): Record<string, BrowserCase> {
  const source: unknown = JSON.parse(readFileSync('scripts/voice/browser-cases.json', 'utf8'));
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid browser cases');
  const result: Record<string, BrowserCase> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object'
      || !('platform' in value) || (value.platform !== 'win32' && value.platform !== 'linux')
      || !('project' in value) || typeof value.project !== 'string'
      || !('browserName' in value) || (value.browserName !== 'chromium' && value.browserName !== 'webkit')
      || !('channel' in value) || (value.channel !== 'msedge' && value.channel !== null)
      || !('device' in value) || typeof value.device !== 'string') throw new Error(`Invalid browser case: ${key}`);
    result[key] = { platform: value.platform, project: value.project, browserName: value.browserName,
      channel: value.channel, device: value.device };
  }
  return result;
}

export const browserCases = loadCases();

export function selectBrowserCase(caseId: string): BrowserCase {
  if (!Object.hasOwn(browserCases, caseId)) throw new Error(`Unknown browser case: ${caseId}`);
  return browserCases[caseId];
}

export function browserEvidenceDirectory(caseId?: string): string {
  if (caseId === undefined) return 'installed-browser-evidence';
  selectBrowserCase(caseId);
  return `installed-browser-${caseId}`;
}

export const browserImplementationFiles = [
  'app/features/composer/voice/voiceRecorder.ts', 'app/features/composer/voice/useVoiceInput.ts',
  'public/voice/recorder-worklet.js', 'lib/voice/audio.ts', 'lib/voice/process.ts',
  'tests/helpers/voiceBrowserCapture.ts', 'tests/voice-installed-browser.spec.ts',
  'tests/playwright.config.ts', 'tests/playwright.voice-matrix.config.ts',
  'scripts/voice/browser-cases.json', 'scripts/voice/browser-cases.ts',
  'scripts/voice/installed-api-run.mjs',
];
