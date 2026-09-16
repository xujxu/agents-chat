'use client';

import { useEffect } from 'react';
import {
  buildScaleLockedViewportContent,
  isIOSDevice,
} from '../orientationScaleRecovery';
import { APP_VIEWPORT_WILL_CHANGE_EVENT } from '../viewportEvents';

const ORIENTATION_SETTLE_MS = 250;
const ORIENTATION_MAX_WAIT_MS = 2_000;
const RECOVERY_ERROR_PREFIX =
  '[viewport] Failed to recover iOS orientation scale.';

type OriginalViewport = {
  element: HTMLMetaElement;
  content: string;
  hadContentAttribute: boolean;
};

export function useIOSOrientationScaleRecovery() {
  useEffect(() => {
    if (!isIOSDevice(navigator)) return;

    const visualViewport = window.visualViewport;
    let generation = 0;
    let orientationActive = false;
    let settleTimer: number | null = null;
    let maximumTimer: number | null = null;
    let firstFrame = 0;
    let secondFrame = 0;
    let originalViewport: OriginalViewport | null = null;

    const reportError = (error: unknown) => {
      console.error(RECOVERY_ERROR_PREFIX, error);
    };

    const restoreOriginalViewport = () => {
      if (!originalViewport) return;
      const { element, content, hadContentAttribute } = originalViewport;
      originalViewport = null;
      try {
        if (hadContentAttribute) element.setAttribute('content', content);
        else element.removeAttribute('content');
      } catch (error) {
        reportError(error);
      }
    };

    const cancelScheduledWork = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      if (maximumTimer !== null) window.clearTimeout(maximumTimer);
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      settleTimer = null;
      maximumTimer = null;
      firstFrame = 0;
      secondFrame = 0;
    };

    const recoverSettledOrientation = (targetGeneration: number) => {
      if (!orientationActive || targetGeneration !== generation) return;
      orientationActive = false;
      cancelScheduledWork();

      const viewport = document.querySelector<HTMLMetaElement>(
        'meta[name="viewport"]',
      );
      if (!viewport) {
        reportError(new Error('Viewport meta element was not found.'));
        return;
      }

      const originalContent = viewport.getAttribute('content') ?? '';
      originalViewport = {
        element: viewport,
        content: originalContent,
        hadContentAttribute: viewport.hasAttribute('content'),
      };

      try {
        viewport.setAttribute(
          'content',
          buildScaleLockedViewportContent(originalContent),
        );
        firstFrame = window.requestAnimationFrame(() => {
          firstFrame = 0;
          secondFrame = window.requestAnimationFrame(() => {
            secondFrame = 0;
            restoreOriginalViewport();
          });
        });
      } catch (error) {
        restoreOriginalViewport();
        reportError(error);
      }
    };

    const scheduleSettledRecovery = () => {
      if (!orientationActive) return;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      const targetGeneration = generation;
      settleTimer = window.setTimeout(
        () => recoverSettledOrientation(targetGeneration),
        ORIENTATION_SETTLE_MS,
      );
    };

    const beginOrientationRecovery = () => {
      generation += 1;
      cancelScheduledWork();
      restoreOriginalViewport();
      orientationActive = true;
      window.dispatchEvent(new Event(APP_VIEWPORT_WILL_CHANGE_EVENT));
      scheduleSettledRecovery();
      const targetGeneration = generation;
      maximumTimer = window.setTimeout(
        () => recoverSettledOrientation(targetGeneration),
        ORIENTATION_MAX_WAIT_MS,
      );
    };

    window.addEventListener('orientationchange', beginOrientationRecovery);
    window.addEventListener('resize', scheduleSettledRecovery);
    visualViewport?.addEventListener('resize', scheduleSettledRecovery);
    return () => {
      generation += 1;
      orientationActive = false;
      window.removeEventListener(
        'orientationchange',
        beginOrientationRecovery,
      );
      window.removeEventListener('resize', scheduleSettledRecovery);
      visualViewport?.removeEventListener('resize', scheduleSettledRecovery);
      cancelScheduledWork();
      restoreOriginalViewport();
    };
  }, []);
}
