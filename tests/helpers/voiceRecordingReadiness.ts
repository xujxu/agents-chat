import { expect, type Page } from '@playwright/test';

export type VoiceRecordingObservation = {
  statusText: string | null;
  statusVisible: boolean;
  stopVisible: boolean;
  stopEnabled: boolean;
};

export async function observeVoiceRecording(
  page: Page,
): Promise<VoiceRecordingObservation> {
  return page.evaluate(() => {
    const statuses = document.querySelectorAll<HTMLElement>('.voiceStatus[role="status"]');
    const stops = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Stop recording"]',
    );
    if (statuses.length > 1 || stops.length > 1) {
      throw new Error('Expected at most one voice status and stop recording button');
    }
    const status = statuses.item(0);
    const stop = stops.item(0);
    const visible = (element: HTMLElement | null): boolean => {
      if (!element || getComputedStyle(element).visibility !== 'visible') return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    };
    return {
      statusText: status?.textContent ?? null,
      statusVisible: visible(status),
      stopVisible: visible(stop),
      stopEnabled: stop !== null && !stop.matches(':disabled'),
    };
  });
}

export function isVoiceRecordingReady(observation: VoiceRecordingObservation): boolean {
  return observation.statusVisible
    && observation.stopVisible
    && observation.stopEnabled
    && /^Recording 0:(?:0[1-9]|1[0-9]|2[0-9]) \/ 0:30(?![\s\S])/.test(observation.statusText ?? '');
}

export async function waitForVoiceRecordingReady(page: Page): Promise<void> {
  await expect.poll(async () => {
    const observation = await observeVoiceRecording(page);
    return isVoiceRecordingReady(observation) ? 'ready' : observation;
  }, {
    message: 'Expected visible recording at 1-29 seconds with an enabled stop button',
  }).toBe('ready');
}
